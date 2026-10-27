const uap = require('ua-parser-js');
const { isEnabled, createSubscriptionGate } = require('@librechat/api');
const denyRequest = require('./denyRequest');

/**
 * Soft subscription gate (behavior in packages/api/src/subscription): denies new model
 * work for accounts without an active subscription, keeping read, abort and cancel
 * access open. Armed by SUBSCRIPTION_GATE the same way checkBan is armed by
 * BAN_VIOLATIONS; off reproduces today's behavior.
 */
const gate = createSubscriptionGate({
  isBrowser: (req) => Boolean(uap(req.headers['user-agent']).browser.name),
  denyInChat: denyRequest,
  getPortalUrl: () => process.env.SUBSCRIPTION_PORTAL_URL,
});

module.exports = async function checkSubscription(req, res, next) {
  if (!isEnabled(process.env.SUBSCRIPTION_GATE)) {
    return next();
  }
  return gate(req, res, next);
};
