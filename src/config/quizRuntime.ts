function resolveFlag(value: string | undefined, productionDefault: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return productionDefault;
  }
  return normalized === "true";
}

export function isQuizContinuousEnabled(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return resolveFlag(
    environment.QUIZ_CONTINUOUS,
    environment.NODE_ENV?.trim().toLowerCase() === "production"
  );
}

export function isQuizAutoStartEnabled(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return isQuizContinuousEnabled(environment) || resolveFlag(
    environment.QUIZ_AUTO_START,
    environment.NODE_ENV?.trim().toLowerCase() === "production"
  );
}
