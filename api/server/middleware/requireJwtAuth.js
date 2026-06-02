const cookies = require('cookie');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const {
  isEnabled,
  tenantContextMiddleware,
  maybeRefreshCloudFrontAuthCookiesMiddleware,
} = require('@librechat/api');
const { findUser, createUser } = require('~/models');

let noAuthUserPromise;

const resolveNoAuthUser = async () => {
  if (noAuthUserPromise) {
    return noAuthUserPromise;
  }

  noAuthUserPromise = (async () => {
    const email = process.env.NO_AUTH_USER_EMAIL || 'local@librechat.local';
    const username = process.env.NO_AUTH_USER_NAME || 'local_user';
    const role = process.env.NO_AUTH_USER_ROLE || 'ADMIN';

    let user = await findUser({ email });

    if (!user) {
      await createUser(
        {
          email,
          username,
          name: username,
          provider: 'local',
          emailVerified: true,
          role,
          termsAccepted: true,
        },
        undefined,
        true,
        false,
      );

      user = await findUser({ email });
    }

    if (!user) {
      throw new Error('NO_AUTH_MODE enabled but failed to resolve local user');
    }

    return user;
  })();

  try {
    return await noAuthUserPromise;
  } catch (error) {
    noAuthUserPromise = undefined;
    throw error;
  }
};

const hasPassportStrategy = (strategy) =>
  typeof passport._strategy === 'function' && passport._strategy(strategy) != null;

const getValidOpenIdReuseUserId = (parsedCookies) => {
  const openidUserId = parsedCookies.openid_user_id;
  if (!openidUserId || !process.env.JWT_REFRESH_SECRET) {
    return null;
  }

  try {
    const payload = jwt.verify(openidUserId, process.env.JWT_REFRESH_SECRET);
    return typeof payload === 'object' && payload != null && typeof payload.id === 'string'
      ? payload.id
      : null;
  } catch {
    return null;
  }
};

const getAuthenticatedUserId = (user) => user?.id?.toString?.() ?? user?._id?.toString?.();
const refreshCloudFrontCookies =
  maybeRefreshCloudFrontAuthCookiesMiddleware ?? ((_req, _res, next) => next());

/**
 * Custom Middleware to handle JWT authentication, with support for OpenID token reuse.
 * Switches between JWT and OpenID authentication based on cookies and environment settings.
 *
 * After successful authentication (req.user populated), automatically chains into
 * `tenantContextMiddleware` to propagate request context into AsyncLocalStorage
 * for downstream Mongoose tenant isolation and structured logging.
 */
const requireJwtAuth = async (req, res, next) => {
  if (isEnabled(process.env.NO_AUTH_MODE)) {
    try {
      const user = await resolveNoAuthUser();
      req.user = {
        ...user,
        id: user.id || user._id?.toString?.() || user._id,
      };
      return tenantContextMiddleware(req, res, next);
    } catch (error) {
      return next(error);
    }
  }

  const cookieHeader = req.headers.cookie;
  const parsedCookies = cookieHeader ? cookies.parse(cookieHeader) : {};
  const tokenProvider = parsedCookies.token_provider;
  const openidReuseEnabled = isEnabled(process.env.OPENID_REUSE_TOKENS);
  const openidJwtAvailable = openidReuseEnabled && hasPassportStrategy('openidJwt');
  const openIdReuseUserId = getValidOpenIdReuseUserId(parsedCookies);
  const useOpenIdJwt =
    tokenProvider === 'openid' && openidJwtAvailable && openIdReuseUserId != null;
  const strategies = useOpenIdJwt ? ['openidJwt', 'jwt'] : ['jwt'];

  const authenticateWithStrategy = (index) => {
    const strategy = strategies[index];
    passport.authenticate(strategy, { session: false }, (err, user, info, status) => {
      if (err) {
        return next(err);
      }
      if (!user) {
        if (index + 1 < strategies.length) {
          return authenticateWithStrategy(index + 1);
        }
        return res.status(status || 401).json({
          message: info?.message || 'Unauthorized',
        });
      }
      if (strategy === 'openidJwt' && getAuthenticatedUserId(user) !== openIdReuseUserId) {
        if (index + 1 < strategies.length) {
          return authenticateWithStrategy(index + 1);
        }
        return res.status(401).json({ message: 'Unauthorized' });
      }
      req.user = user;
      req.authStrategy = strategy;
      tenantContextMiddleware(req, res, (tenantErr) => {
        if (tenantErr) {
          return next(tenantErr);
        }
        refreshCloudFrontCookies(req, res, next);
      });
    })(req, res, next);
  };

  authenticateWithStrategy(0);
};

module.exports = requireJwtAuth;
