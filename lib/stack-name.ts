export const DEFAULT_STACK_NAME = 'minivela';

const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;
const MAX_STACK_NAME_LENGTH = 128;

export function stackNameFromContext(value: unknown): string {
  if (value === undefined) {
    return DEFAULT_STACK_NAME;
  }
  if (typeof value !== 'string' || value.length > MAX_STACK_NAME_LENGTH || !STACK_NAME.test(value)) {
    throw new Error(
      'stackName must start with a letter and contain only letters, digits, and hyphens (128 characters max)',
    );
  }
  return value;
}
