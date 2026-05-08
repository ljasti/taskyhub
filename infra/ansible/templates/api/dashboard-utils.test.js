const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeWorkflowHealth,
  normalizeFailureDetails,
  truncateErrorMessage,
} = require('./dashboard-utils');

test('zero execution workflows are marked as No Data', () => {
  const result = computeWorkflowHealth({
    total_executions: 0,
    successful_executions: 0,
    failed_executions: 0,
    avg_duration: 0,
  });

  assert.equal(result.healthCategory, 'No Data');
  assert.equal(result.healthScore, null);
  assert.equal(result.failureRate, 0);
});

test('failed execution payload surfaces error message and node', () => {
  const result = normalizeFailureDetails({
    status: 'failed',
    data: {
      executionData: {
        resultData: {
          lastNodeExecuted: 'HTTP Request',
          error: {
            name: 'NodeApiError',
            message: 'Request failed with status code 500',
          },
        },
      },
    },
  });

  assert.equal(result.failedNode, 'HTTP Request');
  assert.equal(result.errorType, 'NodeApiError');
  assert.equal(result.errorMessage, 'Request failed with status code 500');
});

test('runData node errors are surfaced when present', () => {
  const result = normalizeFailureDetails({
    status: 'error',
    data: {
      resultData: {
        runData: {
          'Code Node': [
            {
              error: {
                name: 'NodeOperationError',
                message: 'Cannot read properties of undefined',
                stack: 'stack-line-1',
              },
            },
          ],
        },
      },
    },
  });

  assert.equal(result.failedNode, 'Code Node');
  assert.equal(result.errorType, 'NodeOperationError');
  assert.equal(result.errorMessage, 'Cannot read properties of undefined');
  assert.equal(result.stackTrace, 'stack-line-1');
});

test('fallback status message used when error payload missing', () => {
  const result = normalizeFailureDetails({
    status: 'error',
    data: null,
  });

  assert.match(result.errorMessage, /Execution ended with status: error/);
  assert.equal(result.failedNode, 'Unknown');
});

test('truncateErrorMessage shortens long messages', () => {
  const longMessage = 'x'.repeat(200);
  const truncated = truncateErrorMessage(longMessage, 50);

  assert.equal(truncated.length, 50);
  assert.ok(truncated.endsWith('...'));
});
