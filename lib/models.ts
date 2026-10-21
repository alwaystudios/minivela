export const EXTRACT_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
export const GOOSE_MODEL_ID = 'deepseek.v3.2';
export const EMBED_MODEL_ID = 'amazon.titan-embed-text-v2:0';
export const EMBEDDING_DIMENSIONS = 1024;
export const MAX_EMBED_INPUT_CHARS = 28_000;

export const BEDROCK_REGIONS = ['us-east-1', 'us-east-2', 'us-west-2'] as const;

export function assertBedrockRegion(region: string | undefined): void {
  if (!region) {
    return;
  }
  if (!BEDROCK_REGIONS.includes(region as (typeof BEDROCK_REGIONS)[number])) {
    throw new Error(
      `Deploy in ${BEDROCK_REGIONS.join(', ')}. The extract model is a US Bedrock profile and cannot be called from ${region}.`,
    );
  }
}
