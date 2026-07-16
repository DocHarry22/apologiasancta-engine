function isEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function isQuizContinuousEnabled(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return isEnabled(environment.QUIZ_CONTINUOUS);
}

export function isQuizAutoStartEnabled(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return isQuizContinuousEnabled(environment) || isEnabled(environment.QUIZ_AUTO_START);
}
