import { Minimatch } from 'minimatch';

export function isFileIgnored(filename: string, ignorePatterns: string[]): boolean {
  return ignorePatterns.some(pattern => {
    const matcher = new Minimatch(pattern, { dot: true });
    return matcher.match(filename);
  });
}

// Simple logic to parse /review command and extra args
export function parseReviewComment(comment: string): { isReview: boolean; instructions?: string } {
  const trimmed = comment.trim();
  if (!trimmed.startsWith('/review')) {
    return { isReview: false };
  }

  const instructions = trimmed.replace('/review', '').trim();
  return {
    isReview: true,
    instructions: instructions.length > 0 ? instructions : undefined,
  };
}

export function processDiff(diff: string): string {
  const lines = diff.split('\n');
  const processedLines: string[] = [];
  let currentLineNumber = 0;

  for (const line of lines) {
    // Check for chunk header
    // @@ -oldStart,oldLen +newStart,newLen @@
    const chunkHeader = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (chunkHeader) {
      currentLineNumber = parseInt(chunkHeader[1], 10);
      processedLines.push(line);
      continue;
    }

    // Check for content lines
    if (line.startsWith(' ') || (line.startsWith('+') && !line.startsWith('+++'))) {
      // It's a context line or an added line
      // We need to output the line number
      processedLines.push(`${currentLineNumber.toString().padStart(5)}: ${line}`);
      currentLineNumber++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // Deleted line, no new line number
      processedLines.push(`       : ${line}`);
    } else {
      // Metadata lines (index, ---, +++, diff --git, etc.)
      processedLines.push(line);
    }
  }

  return processedLines.join('\n');
}