const cookies = require('cookie');
const passport = require('passport');
const { isEnabled } = require('@librechat/api');
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

/**
 * Custom Middleware to handle JWT authentication, with support for OpenID token reuse
 * Switches between JWT and OpenID authentication based on cookies and environment settings
 */
const requireJwtAuth = async (req, res, next) => {
  if (isEnabled(process.env.NO_AUTH_MODE)) {
    try {
      const user = await resolveNoAuthUser();
      req.user = {
        ...user,
        id: user.id || user._id?.toString?.() || user._id,
      };
      return next();
    } catch (error) {
      return next(error);
    }
  }

  const cookieHeader = req.headers.cookie;
  const tokenProvider = cookieHeader ? cookies.parse(cookieHeader).token_provider : null;

  if (tokenProvider === 'openid' && isEnabled(process.env.OPENID_REUSE_TOKENS)) {
    return passport.authenticate('openidJwt', { session: false })(req, res, next);
  }

  return passport.authenticate('jwt', { session: false })(req, res, next);
};

module.exports = requireJwtAuth;
