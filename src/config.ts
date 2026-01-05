import * as core from "@actions/core";

export type SeverityLevel = "low" | "medium" | "high" | "critical";

export interface Config {
  openaiApiKey: string;
  openaiBaseUrl: string;
  model: string;
  githubToken: string;
  systemMessage: string;
  ignorePatterns: string[];
  minSeverity: SeverityLevel;
  disableInline: boolean;
}

export function getConfig(): Config {
  const minSeverityInput = core.getInput("min_severity") || "low";
  const minSeverity = normalizeSeverity(minSeverityInput);

  // Validate minSeverity input
  if (minSeverityInput !== minSeverity) {
    core.warning(
      `Invalid min_severity value "${minSeverityInput}", defaulting to "${minSeverity}"`,
    );
  }

  return {
    openaiApiKey: core.getInput("openai_api_key", { required: true }),
    openaiBaseUrl:
      core.getInput("openai_base_url") || "https://api.openai.com/v1",
    model: core.getInput("model") || "gpt-4o",
    githubToken: core.getInput("github_token", { required: true }),
    systemMessage:
      core.getInput("system_message") ||
      "You are an expert code reviewer. Provide a summary of changes and inline comments for improvements.",
    ignorePatterns: (core.getInput("ignore_patterns") || "")
      .split(",")
      .map((p: string) => p.trim())
      .filter((p: string) => p.length > 0),
    minSeverity,
    disableInline: core.getBooleanInput("disable_inline"),
  };
}

function normalizeSeverity(severity: string): SeverityLevel {
  const lower = severity.toLowerCase().trim();
  if (["low", "medium", "high", "critical"].includes(lower)) {
    return lower as SeverityLevel;
  }
  // Default to 'low' for invalid severity values
  return "low";
}
