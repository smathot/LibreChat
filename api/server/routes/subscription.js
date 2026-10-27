const express = require('express');
const { logger } = require('@librechat/data-schemas');
const {
  createSubscriptionSyncAuth,
  syncSubscription,
  addSubscriptionBalance,
  getBalanceConfig,
} = require('@librechat/api');
const {
  findUser,
  getUserById,
  updateUser,
  createTransaction,
} = require('~/models');
const { getAppConfig } = require('~/server/services/Config');

/**
 * Server-to-server subscription endpoints for the external subscription app.
 * Shared-secret auth (SUBSCRIPTION_SYNC_SECRET); behavior in
 * packages/api/src/subscription. When the secret is unset the routes answer 404,
 * so the feature is fully off rather than half-open.
 */
const router = express.Router();

const syncAuth = createSubscriptionSyncAuth({
  getSecret: () => process.env.SUBSCRIPTION_SYNC_SECRET,
  warn: (message) => logger.warn(message),
});

router.post('/sync', syncAuth, async (req, res, next) => {
  try {
    const result = await syncSubscription({ findUser, getUserById, updateUser }, req.body);
    if (!result.ok) {
      return res.status(result.error.status).json({ code: result.error.code });
    }
    logger.info('[subscriptionSync] updated subscription state', {
      userId: result.value.userId,
      active: result.value.active,
      expiresAt: result.value.expiresAt,
    });
    return res.json(result.value);
  } catch (error) {
    return next(error);
  }
});

router.post('/add-balance', syncAuth, async (req, res, next) => {
  try {
    /** The deployment's configured balance feature, resolved once per request the way
     *  the CLI and the login balance sync do; `getAppConfig` caches internally. */
    const appConfig = await getAppConfig({ baseOnly: true });
    const balanceEnabled = getBalanceConfig(appConfig)?.enabled === true;
    const result = await addSubscriptionBalance(
      {
        findUser,
        getUserById,
        addCredits: createTransaction,
        isBalanceEnabled: () => balanceEnabled,
      },
      req.body,
    );
    if (!result.ok) {
      return res.status(result.error.status).json({ code: result.error.code });
    }
    logger.info('[subscriptionAddBalance] credited purchased credits', {
      userId: result.value.userId,
      added: result.value.added,
      tokenCredits: result.value.tokenCredits,
    });
    return res.json(result.value);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
