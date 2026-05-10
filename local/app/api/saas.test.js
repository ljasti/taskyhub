const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getPricingPlanSeeds,
  normalizeUserRole,
  roleRank,
  getEffectiveRole,
  hasPermission,
  validateSeatLimit,
  validatePlanChangeUserCount,
} = require('./index');

test('pricing plan seeds include STARTER, TEAM, BUSINESS with expected limits and prices', () => {
  const seeds = getPricingPlanSeeds();
  const byCode = new Map(seeds.map((p) => [p.code, p]));

  assert.ok(byCode.has('STARTER'));
  assert.ok(byCode.has('TEAM'));
  assert.ok(byCode.has('BUSINESS'));

  assert.equal(byCode.get('STARTER').monthly, 1900);
  assert.equal(byCode.get('STARTER').yearly, 19000);
  assert.equal(byCode.get('STARTER').maxUsers, 3);
  assert.equal(byCode.get('STARTER').maxWorkflows, 10);
  assert.equal(byCode.get('STARTER').maxTasks, 1000);
  assert.equal(byCode.get('STARTER').includedRuns, 5000);
  assert.equal(byCode.get('STARTER').overage, 500);

  assert.equal(byCode.get('TEAM').monthly, 4900);
  assert.equal(byCode.get('TEAM').yearly, 49000);
  assert.equal(byCode.get('TEAM').maxUsers, 10);
  assert.equal(byCode.get('TEAM').maxWorkflows, 25);
  assert.equal(byCode.get('TEAM').maxTasks, 10000);
  assert.equal(byCode.get('TEAM').includedRuns, 25000);
  assert.equal(byCode.get('TEAM').overage, 400);

  assert.equal(byCode.get('BUSINESS').monthly, 9900);
  assert.equal(byCode.get('BUSINESS').yearly, 99000);
  assert.equal(byCode.get('BUSINESS').maxUsers, 25);
  assert.equal(byCode.get('BUSINESS').maxWorkflows, 100);
  assert.equal(byCode.get('BUSINESS').maxTasks, 100000);
  assert.equal(byCode.get('BUSINESS').includedRuns, 100000);
  assert.equal(byCode.get('BUSINESS').overage, 300);
});

test('normalizeUserRole maps legacy user role to member', () => {
  assert.equal(normalizeUserRole('user'), 'member');
  assert.equal(normalizeUserRole('Member'), 'member');
  assert.equal(normalizeUserRole('ADMIN'), 'admin');
  assert.equal(normalizeUserRole('owner'), 'owner');
});

test('roleRank orders member < admin < owner', () => {
  assert.ok(roleRank('member') < roleRank('admin'));
  assert.ok(roleRank('admin') < roleRank('owner'));
});

test('RBAC: CS denied monitoring; Technical denied billing/user management; Super Admin allowed', () => {
  const csUser = { role: 'cs', is_super_admin: false, is_owner: false };
  const technicalUser = { role: 'technical', is_super_admin: false, is_owner: false };
  const tenantAdmin = { role: 'admin', is_super_admin: false, is_owner: false };
  const superAdmin = { role: 'super_admin', is_super_admin: true };

  assert.equal(getEffectiveRole(csUser), 'cs');
  assert.equal(getEffectiveRole(technicalUser), 'technical');
  assert.equal(getEffectiveRole(superAdmin), 'super_admin');

  assert.equal(hasPermission(csUser, 'MONITORING_VIEW'), false);
  assert.equal(hasPermission(csUser, 'SUBSCRIPTION_VIEW'), true);
  assert.equal(hasPermission(csUser, 'USERS_VIEW'), true);
  assert.equal(hasPermission(csUser, 'INTEGRATIONS_VIEW'), false);

  assert.equal(hasPermission(technicalUser, 'MONITORING_VIEW'), true);
  assert.equal(hasPermission(technicalUser, 'SUBSCRIPTION_VIEW'), true);
  assert.equal(hasPermission(technicalUser, 'SUBSCRIPTION_CHANGE_PLAN'), false);
  assert.equal(hasPermission(technicalUser, 'USERS_VIEW'), false);
  assert.equal(hasPermission(technicalUser, 'USERS_MANAGE'), false);
  assert.equal(hasPermission(technicalUser, 'INTEGRATIONS_VIEW'), true);
  assert.equal(hasPermission(technicalUser, 'INTEGRATIONS_MANAGE'), true);

  assert.equal(hasPermission(tenantAdmin, 'SUBSCRIPTION_CHANGE_PLAN'), true);
  assert.equal(hasPermission(tenantAdmin, 'USERS_MANAGE'), true);

  assert.equal(hasPermission(superAdmin, 'MONITORING_VIEW'), true);
  assert.equal(hasPermission(superAdmin, 'SUBSCRIPTION_CHANGE_PLAN'), true);
  assert.equal(hasPermission(superAdmin, 'USERS_MANAGE'), true);
});

test('validateSeatLimit blocks when used >= limit', () => {
  assert.equal(validateSeatLimit({ currentUsersCount: 9, seatLimit: 10 }), '');
  assert.equal(validateSeatLimit({ currentUsersCount: 10, seatLimit: 10 }), 'Seat limit reached for your subscription plan.');
  assert.equal(validateSeatLimit({ currentUsersCount: 11, seatLimit: 10 }), 'Seat limit reached for your subscription plan.');
});

test('validatePlanChangeUserCount blocks when used > plan max_users', () => {
  assert.equal(validatePlanChangeUserCount({ currentUsersCount: 10, planMaxUsers: 10 }), '');
  assert.match(
    validatePlanChangeUserCount({ currentUsersCount: 12, planMaxUsers: 10 }),
    /You have 12 users but the selected plan allows only 10/
  );
});
