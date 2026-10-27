const express = require('express');
const { logger } = require('@librechat/data-schemas');
const { createSubscriptionSyncAuth, syncSubscription } = require('@librechat/api');
const { findUser, getUserById, updateUser } = require('~/models');

/**
 * Server-to-server subscription state sync for the external subscription app.
 * Shared-secret auth (SUBSCRIPTION_SYNC_SECRET); behavior in
 * packages/api/src/subscription. When the secret is unset the route answers 404,
 * so the feature is fully off rather than half-open.
 */
const router = express.Router();

router.post(
  '/sync',
  createSubscriptionSyncAuth({
    getSecret: () => process.env.SUBSCRIPTION_SYNC_SECRET,
    warn: (message) => logger.warn(message),
  }),
  async (req, res, next) => {
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
  },
);

module.exports = router;
