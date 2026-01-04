import { Minimatch } from "minimatch";
import parseDiff from "parse-diff";

export function isFileIgnored(
  filename: string,
  ignorePatterns: string[],
): boolean {
  return ignorePatterns.some((pattern) => {
    const matcher = new Minimatch(pattern, { dot: true });
    return matcher.match(filename);
  });
}

// Simple logic to parse /review command and extra args
export function parseReviewComment(comment: string): {
  isReview: boolean;
  instructions?: string;
} {
  const trimmed = comment.trim();
  if (!trimmed.startsWith("/review")) {
    return { isReview: false };
  }

  const instructions = trimmed.replace("/review", "").trim();
  return {
    isReview: true,
    instructions: instructions.length > 0 ? instructions : undefined,
  };
}

export function processDiff(diff: string): string {
  try {
    const parsed = parseDiff(diff);
    const processedLines: string[] = [];

    // Process each file
    for (const file of parsed) {
      // Add the original header lines for this file
      processedLines.push(`diff --git a/${file.from} b/${file.to}`);
      if (file.index) {
        processedLines.push(`index ${file.index.join(" ")}`);
      }
      processedLines.push(`--- a/${file.from}`);
      processedLines.push(`+++ b/${file.to}`);

      // Process each chunk in the file
      for (const chunk of file.chunks) {
        // Add chunk header
        processedLines.push(chunk.content);

        // Process each change in the chunk
        for (const change of chunk.changes) {
          if (change.type === "add") {
            // Added line - use ln (which is the new file line number)
            processedLines.push(
              `${change.ln.toString().padStart(5)}: ${change.content}`,
            );
          } else if (change.type === "normal") {
            // Context line - use ln2 (new file line number)
            processedLines.push(
              `${change.ln2!.toString().padStart(5)}: ${change.content}`,
            );
          } else if (change.type === "del") {
            // Deleted line - doesn't exist in new file, so no line number
            processedLines.push(`       : ${change.content}`);
          }
        }
      }
    }

    return processedLines.join("\n");
  } catch (error) {
    throw new Error(
      `Failed to parse diff: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
