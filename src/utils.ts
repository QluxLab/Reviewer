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