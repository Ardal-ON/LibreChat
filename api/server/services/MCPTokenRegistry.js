const { logger } = require('@librechat/data-schemas');
const { v4: uuidv4 } = require('uuid');

/**
 * Service for managing MCP registration tokens.
 * In development, this uses an in-memory Map.
 * For production, this should be swapped with a database implementation (e.g., MongoDB/Redis).
 */
class MCPTokenRegistry {
  constructor() {
    // In-memory storage: token -> { port, expiresAt, userId, relayId }
    this.tokens = new Map();
    // Default TTL: 5 minutes
    this.defaultTTL = 5 * 60 * 1000;
    
    // Cleanup interval (every minute)
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 60 * 1000);
  }

  /**
   * Register a new token
   * @param {Object} params
   * @param {string} params.token - The token from the plugin (or generate one if not provided)
   * @param {number} params.port - The local port on the user's machine (informational)
   * @param {number} params.ttl - TTL in milliseconds
   * @param {string} [params.userId] - The user ID if known
   * @returns {string} The registered token
   */
  registerToken({ token, port, ttl, userId }) {
    const finalToken = token || uuidv4();
    const finalTTL = ttl || this.defaultTTL;
    const expiresAt = Date.now() + finalTTL;

    this.tokens.set(finalToken, {
      port,
      expiresAt,
      userId,
      createdAt: Date.now(),
    });

    logger.debug(`[MCPTokenRegistry] Registered token: ${finalToken.substring(0, 8)}... for port ${port}`);
    return finalToken;
  }

  /**
   * Get token data if valid
   * @param {string} token 
   * @returns {Object|null} Token data or null if invalid/expired
   */
  getTokenData(token) {
    const data = this.tokens.get(token);
    if (!data) {
      return null;
    }

    if (Date.now() > data.expiresAt) {
      this.tokens.delete(token);
      return null;
    }

    return data;
  }

  /**
   * Consume a token (mark as used/remove)
   * @param {string} token 
   * @returns {Object|null} Token data if successfully consumed, null otherwise
   */
  consumeToken(token) {
    const data = this.getTokenData(token);
    if (data) {
      this.tokens.delete(token);
      return data;
    }
    return null;
  }

  /**
   * Remove expired tokens
   */
  cleanupExpired() {
    const now = Date.now();
    let count = 0;
    for (const [token, data] of this.tokens.entries()) {
      if (now > data.expiresAt) {
        this.tokens.delete(token);
        count++;
      }
    }
    if (count > 0) {
      logger.debug(`[MCPTokenRegistry] Cleaned up ${count} expired tokens`);
    }
  }

  /**
   * Destroy the registry (stop cleanup interval)
   */
  destroy() {
    clearInterval(this.cleanupInterval);
  }
}

// Singleton instance
const mcpTokenRegistry = new MCPTokenRegistry();

module.exports = {
  mcpTokenRegistry,
  MCPTokenRegistry,
};
