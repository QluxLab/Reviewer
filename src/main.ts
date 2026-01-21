import * as core from "@actions/core";
import * as github from "@actions/github";
import { getConfig } from "./config";
import { GitHubService } from "./services/github";
import { AIService } from "./services/ai";
import {
  isFileIgnored,
  parseReviewComment,
  getSeverityLevel,
  SeverityLevel,
} from "./utils";

async function run(): Promise<void> {
  try {
    const config = getConfig();
    const githubService = new GitHubService(config.githubToken);
    const aiService = new AIService(config);

    const { eventName, payload } = github.context;
    let prNumber: number;
    let customInstructions: string | undefined;

    // 1. Event Handling
    if (eventName === "pull_request") {
      if (payload.action !== "opened" && payload.action !== "synchronize") {
        core.info(`Skipping action: ${payload.action}`);
        return;
      }
      prNumber = payload.pull_request!.number;
      core.info(`📋 Processing PR #${prNumber} (${payload.action})`);
    } else if (eventName === "pull_request_review_comment") {
      if (payload.action !== "created") return;

      const comment = payload.comment;
      const pr = payload.pull_request;
      prNumber = pr!.number;

      if (comment!.user.login === "github-actions[bot]") {
        core.info("Skipping bot's own comment");
        return;
      }

      core.info(`💬 Processing reply in PR #${prNumber} from @${comment!.user.login}`);

      const diff = await githubService.getPullRequestDiff(prNumber);

      core.info("🔍 Fetching comment thread for context...");
      let threadComments: Array<{ author: string; body: string; isBot: boolean }> = [];
      try {
        threadComments = await githubService.getCommentThread(prNumber, comment!.id);
        core.info(`📜 Found ${threadComments.length} messages in thread`);
      } catch (error) {
        core.warning(
          `Failed to fetch comment thread: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }

      if (threadComments.length === 0) {
        threadComments = [
          {
            author: comment!.user.login,
            body: comment!.body,
            isBot: false,
          },
        ];
        core.info("Using fallback single comment context");
      }

      core.info("🤖 Generating AI reply...");
      const reply = await aiService.generateReply(diff, threadComments);

      await githubService.createReply(prNumber, comment!.id, reply);
      core.info("✅ Reply posted successfully");
      return;
    } else if (eventName === "issue_comment") {
      if (payload.action !== "created") return;

      const commentBody = payload.comment!.body;
      const { isReview, instructions } = parseReviewComment(commentBody);

      if (!isReview) {
        core.info("Comment is not a /review command. Skipping.");
        return;
      }

      if (!payload.issue!.pull_request) {
        core.info("Comment is on an Issue, not a PR. Skipping.");
        return;
      }

      prNumber = payload.issue!.number;
      customInstructions = instructions;

      core.info(`🎯 Manual review requested for PR #${prNumber}`);
      if (customInstructions) {
        core.info(`📝 Custom instructions: ${customInstructions.substring(0, 100)}...`);
      }

      await githubService.postComment(prNumber, "👀 AI Review started...");
    } else {
      core.info(`Unsupported event: ${eventName}`);
      return;
    }

    // 2. Fetch Changed Files & Filter Ignored
    core.info("📂 Fetching changed files...");
    const changedFiles = await githubService.getChangedFiles(prNumber);
    core.info(`Found ${changedFiles.length} changed files`);

    const filesToReview = changedFiles.filter(
      (file) => !isFileIgnored(file, config.ignorePatterns),
    );

    const ignoredCount = changedFiles.length - filesToReview.length;
    if (ignoredCount > 0) {
      core.info(`🚫 Ignored ${ignoredCount} files based on patterns`);
    }

    if (filesToReview.length === 0) {
      core.info("No files to review after filtering.");
      await githubService.postComment(
        prNumber,
        "ℹ️ No files to review (all files are in ignore patterns)."
      );
      return;
    }

    core.info(`✅ Reviewing ${filesToReview.length} files`);

    // 3. Fetch Diff
    core.info("📥 Fetching PR diff...");
    const diff = await githubService.getPullRequestDiff(prNumber);
    core.info(`📊 Diff size: ${diff.length} characters`);

    // 4. Fetch Existing Comments for Context and Deduplication
    core.info("💬 Fetching existing bot comments...");
    const existingComments = await githubService.listBotComments(prNumber);

    // Build a set of existing inline comment locations for deduplication
    const existingInlineKeys = new Set<string>();
    const existingInlineComments = existingComments.filter(c => !c.isSummary);

    for (const comment of existingInlineComments) {
      if (comment.path && comment.line) {
        const key = `${comment.path}:${comment.line}`;
        existingInlineKeys.add(key);
        core.debug(`📍 Existing comment at: ${key}`);
      }
    }

    if (existingInlineKeys.size > 0) {
      core.info(`📌 Found ${existingInlineKeys.size} existing inline comment location(s)`);
    }

    // Delete all previous summaries before creating new one
    const deletedSummariesCount = await githubService.deletePreviousSummaries(prNumber);
    if (deletedSummariesCount > 0) {
      core.info(`🧹 Cleaned up ${deletedSummariesCount} previous summary comment(s)`);
    }

    if (eventName === "pull_request" && payload.action === "synchronize") {
      core.info("🔄 Synchronize event: Will deduplicate against existing comments");
    }

    // 5. Get AI Review
    core.info("🤖 Requesting review from AI...");
    const review = await aiService.getReview(diff, existingComments, [], customInstructions);

    // 6. Minimize Outdated Comments
    if (review.minimizeCommentIds && review.minimizeCommentIds.length > 0) {
      const minimizedCount = await githubService.minimizeComments(
        review.minimizeCommentIds,
        prNumber,
        "OUTDATED"
      );
      core.info(`✓ Minimized ${minimizedCount} outdated comment(s)`);
    }

    // 7. Delete Comments
    if (review.deleteCommentIds && review.deleteCommentIds.length > 0) {
      core.info(`🗑️  Deleting ${review.deleteCommentIds.length} comment(s)...`);

      for (const commentId of review.deleteCommentIds) {
        try {
          const commentInfo = existingComments.find(c => c.id === commentId);
          if (commentInfo) {
            if (commentInfo.type === 'issue') {
              await githubService.deleteComment(commentId);
            } else {
              await githubService.deleteReviewComment(commentId);
            }
            core.info(`  ✓ Deleted ${commentInfo.type} comment #${commentId}`);
          } else {
            try {
              await githubService.deleteReviewComment(commentId);
              core.info(`  ✓ Deleted review comment #${commentId}`);
            } catch {
              await githubService.deleteComment(commentId);
              core.info(`  ✓ Deleted issue comment #${commentId}`);
            }
          }
        } catch (error) {
          core.warning(`Failed to delete comment ${commentId}: ${error}`);
        }
      }
    }

    // 8. Process and Deduplicate Comments
    const validComments = review.comments?.filter((c) =>
      filesToReview.includes(c.file),
    ) || [];

    // Filter by severity
    const minSeverityLevel = getSeverityLevel(config.minSeverity);
    const filteredComments = validComments.filter(
      (c) => getSeverityLevel(c.severity) >= minSeverityLevel,
    );

    const severityFilteredCount = validComments.length - filteredComments.length;
    if (severityFilteredCount > 0) {
      core.info(`⚠️  Filtered ${severityFilteredCount} comments below ${config.minSeverity} severity level`);
    }

    // DEDUPLICATION: Filter out comments at existing locations
    const deduplicatedComments = filteredComments.filter(c => {
      const key = `${c.file}:${c.line}`;
      if (existingInlineKeys.has(key)) {
        core.info(`⏭️  Skipping duplicate comment at ${key}`);
        return false;
      }
      return true;
    });

    const duplicateCount = filteredComments.length - deduplicatedComments.length;
    if (duplicateCount > 0) {
      core.info(`🔄 Skipped ${duplicateCount} duplicate comment(s) at existing locations`);
    }

    // Log severity distribution
    const severityCounts: Record<SeverityLevel, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };
    validComments.forEach((c) => {
      severityCounts[c.severity]++;
    });
    core.info(`📊 Severity distribution: ${JSON.stringify(severityCounts)}`);

    if (deduplicatedComments.length > 0) {
      core.info(`💡 Posting ${deduplicatedComments.length} new inline comments`);
    }

    // 9. Post Review
    const commitId = await githubService.getPRHeadSHA(prNumber);

    const formattedComments = deduplicatedComments.map(c => ({
      path: c.file,
      line: c.line,
      body: c.body,
      severity: c.severity
    }));

    await githubService.createReview(
      prNumber,
      commitId,
      review.summary,
      config.disableInline ? undefined : formattedComments
    );

    // 10. Summary
    core.info("✅ Review completed successfully!");
    core.info(`📋 Summary length: ${review.summary.length} characters`);
    core.info(`💬 Inline comments posted: ${deduplicatedComments.length}`);
    core.info(`🔄 Duplicate comments skipped: ${duplicateCount}`);
    core.info(`🔽 Comments minimized: ${review.minimizeCommentIds?.length || 0}`);
    core.info(`🗑️  Comments deleted: ${review.deleteCommentIds?.length || 0}`);

    core.setOutput("summary", review.summary);
    core.setOutput("comments_count", deduplicatedComments.length);
    core.setOutput("duplicates_skipped", duplicateCount);
    core.setOutput("minimized_comments_count", review.minimizeCommentIds?.length || 0);
    core.setOutput("deleted_comments_count", review.deleteCommentIds?.length || 0);
    core.setOutput("severity_distribution", JSON.stringify(severityCounts));

  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(`❌ ${error.message}`);
      core.error(error.stack || "No stack trace available");
    } else {
      core.setFailed("❌ An unknown error occurred");
    }
  }
}

run();