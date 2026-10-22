interface SdlcRunEstimateInput {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

interface SdlcRunEstimateSuccess {
  estimatedUsd: number;
}

interface SdlcRunEstimateError {
  status: 'error';
}

type SdlcRunEstimateResult = SdlcRunEstimateSuccess | SdlcRunEstimateError;

export function estimateSdlcRun(params: SdlcRunEstimateInput): SdlcRunEstimateResult {
  interface ModelPrice {
    inputUsdPer1M: number;
    outputUsdPer1M: number;
  }

  const pricePins: Record<string, ModelPrice> = {
    'deepseek.v3.2': {
      inputUsdPer1M: 0.62,
      outputUsdPer1M: 1.85,
    },
    'us.anthropic.claude-sonnet-4-6': {
      inputUsdPer1M: 3,
      outputUsdPer1M: 15,
    },
  };

  const price = pricePins[params.modelId];
  if (!price) {
    return { status: 'error' };
  }

  const estimatedUsd =
    (params.inputTokens * price.inputUsdPer1M + params.outputTokens * price.outputUsdPer1M) / 1_000_000;

  return { estimatedUsd };
}
