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
  if (params.modelId !== 'deepseek.v3.2') {
    return { status: 'error' };
  }

  const inputPricePerMillion = 0.62;
  const outputPricePerMillion = 1.85;

  const estimatedUsd =
    (params.inputTokens * inputPricePerMillion + params.outputTokens * outputPricePerMillion) / 1_000_000;

  return { estimatedUsd };
}
