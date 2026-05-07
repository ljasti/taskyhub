const FAILED_EXECUTION_STATUSES = ['error', 'failed'];

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeFailureDetails(executionRow) {
  let failedNode = 'Unknown';
  let errorMessage = `Execution ended with status: ${executionRow.status || 'unknown'}`;
  let errorType = executionRow.status || 'Unknown';
  let stackTrace = null;

  try {
    let dataObj = executionRow.data;
    if (typeof dataObj === 'string') {
      dataObj = JSON.parse(dataObj);
    }

    if (!dataObj || typeof dataObj !== 'object') {
      return { failedNode, errorMessage, errorType, stackTrace };
    }

    // n8n versions can store error metadata in different shapes.
    const resultData =
      dataObj?.executionData?.resultData ||
      dataObj?.resultData ||
      dataObj;

    const rawError =
      resultData?.error ||
      dataObj?.error ||
      null;

    if (rawError) {
      errorMessage =
        rawError.message ||
        rawError.description ||
        (typeof rawError === 'string' ? rawError : errorMessage);
      errorType =
        rawError.name ||
        rawError.type ||
        (typeof rawError === 'string' ? executionRow.status || 'Unknown' : errorType);
      stackTrace =
        rawError.stack ||
        rawError.stackTrace ||
        rawError.trace ||
        stackTrace;
    }

    const runData = resultData?.runData || dataObj?.runData;
    if (runData && typeof runData === 'object') {
      for (const [nodeName, nodeExecutions] of Object.entries(runData)) {
        if (!Array.isArray(nodeExecutions)) continue;
        const failedExecution = nodeExecutions.find((entry) => entry?.error);
        if (!failedExecution) continue;
        const nodeError = failedExecution.error;
        failedNode = nodeName || failedNode;
        errorMessage = nodeError.message || nodeError.description || errorMessage;
        errorType = nodeError.name || nodeError.type || errorType;
        stackTrace =
          nodeError.stack ||
          nodeError.stackTrace ||
          nodeError.trace ||
          stackTrace;
        break;
      }
    }

    failedNode =
      resultData?.lastNodeExecuted ||
      dataObj?.lastNodeExecuted ||
      failedNode;
  } catch (_err) {
    // Keep fallbacks if payload parsing fails.
  }

  return { failedNode, errorMessage, errorType, stackTrace };
}

function truncateErrorMessage(message, maxLength = 140) {
  if (!message || typeof message !== 'string') return '';
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength - 3)}...`;
}

function computeWorkflowHealth(workflow) {
  const totalExecutions = toNumber(workflow.total_executions, 0);
  const successfulExecutions = toNumber(workflow.successful_executions, 0);
  const failedExecutions = toNumber(workflow.failed_executions, 0);
  const avgDuration = toNumber(workflow.avg_duration, 0);

  if (totalExecutions === 0) {
    return {
      successRate: 0,
      failureRate: 0,
      healthScore: null,
      healthCategory: 'No Data',
    };
  }

  const successRate = (successfulExecutions / totalExecutions) * 100;
  const failureRate = (failedExecutions / totalExecutions) * 100;

  let healthScore = 0;
  healthScore += successRate * 0.5;
  healthScore += avgDuration > 0 && avgDuration < 30000 ? 20 : avgDuration < 60000 ? 10 : 0;
  healthScore += failureRate < 5 ? 30 : failureRate < 15 ? 15 : 0;
  healthScore = Math.min(100, Math.max(0, healthScore));

  let healthCategory = 'Critical';
  if (healthScore >= 90) healthCategory = 'Excellent';
  else if (healthScore >= 70) healthCategory = 'Healthy';
  else if (healthScore >= 50) healthCategory = 'Warning';

  return {
    successRate,
    failureRate,
    healthScore: Math.round(healthScore),
    healthCategory,
  };
}

module.exports = {
  FAILED_EXECUTION_STATUSES,
  normalizeFailureDetails,
  truncateErrorMessage,
  computeWorkflowHealth,
  toNumber,
};
