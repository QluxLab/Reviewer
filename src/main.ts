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
      // Handle user replies to AI comments
      if (payload.action !== "created") return;

      const comment = payload.comment;
      const pr = payload.pull_request;
      prNumber = pr!.number;

      // Avoid infinite loops - don't reply to our own comments
      if (comment!.user.login === "github-actions[bot]") {
        core.info("Skipping bot's own comment");
        return;
      }

      core.info(`💬 Processing reply in PR #${prNumber} from @${comment!.user.login}`);

      // Fetch the diff for context
      const diff = await githubService.getPullRequestDiff(prNumber);

      // Fetch the full comment thread
      core.info("🔍 Fetching comment thread for context...");
      let threadComments: Array<{ author: string; body: string; isBot: boolean }> = [];
      try {
        threadComments = await githubService.getCommentThread(prNumber, comment!.id);
        core.info(`📜 Found ${threadComments.length} messages in thread`);
      } catch (error) {
        core.warning(
          `Failed to fetch comment thread: ${error instanceof Error ? error.message : "Unknown error"
          }`
        );
      }

      // If thread fetching failed, fallback to single comment
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

      // Ensure it's a PR comment, not just an Issue comment
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

      // Post a reaction to acknowledge the command
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

    // 4. Fetch Existing Comments for Context
    core.info("💬 Fetching existing bot comments...");
    const existingComments = await githubService.listBotComments(prNumber);

    // Extract previous summaries for AI context
    const previousSummaries = existingComments
      .filter(c => c.isSummary)
      .map(c => c.body);

    // Delete all previous summaries before creating new one
    const deletedSummariesCount = await githubService.deletePreviousSummaries(prNumber);
    if (deletedSummariesCount > 0) {
      core.info(`🧹 Cleaned up ${deletedSummariesCount} previous summary comment(s)`);
    }

    // If it's a synchronize event (new commit), we keep existing comments for context
    if (eventName === "pull_request" && payload.action === "synchronize") {
      core.info("🔄 Synchronize event: Using existing comments for consistency and deduplication");
    }

    // 5. Get AI Review (with previous summaries for context)
    core.info("🤖 Requesting review from AI...");
    const review = await aiService.getReview(diff, existingComments, [], customInstructions);

    // 6. Minimize Outdated Comments (as requested by AI)
    if (review.minimizeCommentIds && review.minimizeCommentIds.length > 0) {
      const minimizedCount = await githubService.minimizeComments(
        review.minimizeCommentIds,
        prNumber,
        "OUTDATED"
      );
      core.info(`✓ Minimized ${minimizedCount} outdated comment(s)`);
    }

    // 7. Delete Comments (as requested by AI - use sparingly)
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
            // Fallback if not found in our cache
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

    // 8. Post Review with Summary and Inline Comments
    const validComments = review.comments?.filter((c) =>
      filesToReview.includes(c.file),
    ) || [];

    // Filter comments based on severity
    const minSeverityLevel = getSeverityLevel(config.minSeverity);
    const filteredComments = validComments.filter(
      (c) => getSeverityLevel(c.severity) >= minSeverityLevel,
    );

    // Log filtering results
    const filteredCount = validComments.length - filteredComments.length;
    if (filteredCount > 0) {
      core.info(`⚠️  Filtered ${filteredCount} comments below ${config.minSeverity} severity level`);
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

    if (filteredComments.length > 0) {
      core.info(`💡 Posting ${filteredComments.length} inline comments (${config.minSeverity}+ severity)`);
    }

    // Get PR head SHA for the review
    const commitId = await githubService.getPRHeadSHA(prNumber);

    // Convert comments from AIReviewResponse format to GitHubService format
    // AIReviewResponse uses 'file', but createReview expects 'path'
    const formattedComments = filteredComments.map(c => ({
      path: c.file,
      line: c.line,
      body: c.body,
      severity: c.severity
    }));

    // Post the complete review (summary + inline comments)
    await githubService.createReview(
      prNumber,
      commitId,
      review.summary,
      config.disableInline ? undefined : formattedComments
    );

    // Summary of the review
    core.info("✅ Review completed successfully!");
    core.info(`📋 Summary length: ${review.summary.length} characters`);
    core.info(`💬 Inline comments posted: ${filteredComments.length}`);
    core.info(`🔽 Comments minimized: ${review.minimizeCommentIds?.length || 0}`);
    core.info(`🗑️  Comments deleted: ${review.deleteCommentIds?.length || 0}`);

    // Set outputs for workflow
    core.setOutput("summary", review.summary);
    core.setOutput("comments_count", filteredComments.length);
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