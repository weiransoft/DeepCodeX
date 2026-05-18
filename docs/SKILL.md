---
name: plan-and-execute
description: Automatically plan and execute tasks from issue documents. Reads issue requirements, creates a task list at the end of the document, and systematically executes each task while updating progress. Use when working with issue documents, task planning, or when you need to break down and execute complex multi-step requirements.
---

# Plan and Execute

This Skill helps you automatically plan and execute tasks based on issue documents. It reads your requirements, creates a structured task list directly in the document, and systematically works through each task while keeping the document updated with progress.

## Quick Start

When you need to work through an issue document:

1. The Skill will first ask you for the issue document path
2. It reads the document to understand requirements
3. Creates a task list at the end of the document
4. Executes tasks one by one, updating status in real-time

## Instructions

### Step 1: Get the issue document path

Ask the user for the path to their issue document:

```
What is the path to your issue document?
```

The document can be in any text format (.md, .txt, etc.) that contains task requirements or feature descriptions.

### Step 2: Read and analyze the issue document

Use the Read tool to load the document content and analyze:

- What are the main requirements?
- What tasks need to be completed?
- Are there dependencies between tasks?
- What is the complexity level?

### Step 3: Create the task list

Create a structured task list at the END of the issue document using this format:

```markdown
## Task List

- [ ] Task 1 description
- [ ] Task 2 description
- [ ] Task 3 description

### Task Status Legend
- [ ] Pending
- [>] In Progress
- [x] Completed
```

Use the Edit tool to append this section to the document. Break down complex requirements into specific, actionable tasks.

### Step 4: Execute tasks systematically

For each task in the list:

1. **Mark as in progress**: Update the task in the document from `[ ]` to `[>]`
2. **Execute the task**: Use appropriate tools to complete the work
3. **Mark as completed**: Update the task from `[>]` to `[x]` when finished
4. **Move to next task**: Only ONE task should be in progress at a time

Important rules:
- Always update the document BEFORE starting work on a task
- Always update the document IMMEDIATELY after completing a task
- Never work on multiple tasks simultaneously
- If you encounter errors, keep the task as `[>]` and create new tasks to resolve blockers

### Step 5: Handle task breakdown

If during execution you discover a task is more complex than expected:

1. Keep the current task as `[>]`
2. Add new sub-tasks below it with indentation:
   ```markdown
   - [>] Main task
     - [ ] Sub-task 1
     - [ ] Sub-task 2
   ```
3. Complete sub-tasks first, then mark the main task as complete

### Step 6: Final verification

After all tasks are completed (`[x]`):

1. Review the issue requirements to ensure everything is addressed
2. Run any final checks (tests, builds, linting)
3. Add a completion summary at the end of the document

## Task State Symbols

- `[ ]` - **Pending**: Not started yet
- `[>]` - **In Progress**: Currently working on this
- `[x]` - **Completed**: Finished successfully
- `[!]` - **Blocked**: Cannot proceed (optional, for blocked tasks)

## Examples

### Example 1: Simple feature request

**Issue document (before):**
```markdown
# Feature: Add dark mode toggle

Users should be able to switch between light and dark themes.
The toggle should be in the settings page.
```

**Issue document (after task list added):**
```markdown
# Feature: Add dark mode toggle

Users should be able to switch between light and dark themes.
The toggle should be in the settings page.

## Task List

- [ ] Create dark mode toggle component in Settings page
- [ ] Add dark mode state management (context/store)
- [ ] Implement CSS-in-JS styles for dark theme
- [ ] Update existing components to support theme switching
- [ ] Run tests and verify functionality

### Task Status Legend
- [ ] Pending
- [>] In Progress
- [x] Completed
```

**During execution:**
```markdown
## Task List

- [x] Create dark mode toggle component in Settings page
- [>] Add dark mode state management (context/store)
- [ ] Implement CSS-in-JS styles for dark theme
- [ ] Update existing components to support theme switching
- [ ] Run tests and verify functionality
```

### Example 2: Bug fix with investigation

**Issue document:**
```markdown
# Bug: Login form crashes on submit

When users click submit, the app crashes.
Error message: "Cannot read property 'email' of undefined"
```

**Task list created:**
```markdown
## Task List

- [ ] Reproduce the bug locally
- [ ] Investigate the error in login form component
- [ ] Identify root cause of undefined email property
- [ ] Implement fix
- [ ] Add validation to prevent similar issues
- [ ] Test the fix with various inputs
- [ ] Update error handling

### Task Status Legend
- [ ] Pending
- [>] In Progress
- [x] Completed
```

## When to Use This Skill

Use this Skill when:

1. **Complex multi-step tasks** - Issue requires 3+ distinct steps
2. **Feature implementation** - Building new functionality from requirements
3. **Bug fixing** - Need to investigate, fix, and verify
4. **Refactoring** - Multiple files or components need changes
5. **User provides requirements** - Issue document contains specifications
6. **Need progress tracking** - Want visible progress in the document itself

## When NOT to Use This Skill

Skip this Skill when:

1. **Single simple task** - Just one straightforward action needed
2. **Trivial changes** - Quick fixes that don't need planning
3. **Informational requests** - User just wants explanation, not execution
4. **No document provided** - User hasn't created an issue document

## Best Practices

1. **Be specific with tasks**: "Add login button to navbar" not "Update UI"
2. **Keep tasks atomic**: Each task should be independently completable
3. **Update immediately**: Don't batch status updates, do them in real-time
4. **One task at a time**: Never mark multiple tasks as `[>]`
5. **Handle blockers**: If stuck, create new tasks to resolve the blocker
6. **Verify completion**: Only mark `[x]` when task is fully done

## Advanced Usage

### Handling dependencies

When tasks have dependencies, order them properly:

```markdown
- [ ] Create database schema
- [ ] Implement API endpoints (depends on schema)
- [ ] Build frontend forms (depends on API)
```

### Using sub-tasks

For complex tasks, break them down:

```markdown
- [>] Implement authentication system
  - [x] Set up JWT library
  - [>] Create login endpoint
  - [ ] Create logout endpoint
  - [ ] Add token refresh logic
```

### Adding notes

Add implementation notes or findings:

```markdown
- [x] Investigate performance issue
  - Note: Found N+1 query in user loader
  - Solution: Added dataloader batching
```

## Requirements

This Skill uses standard Deep Code tools:

- **Read**: To read the issue document
- **Edit**: To update task status in the document
- **Bash**: To run tests, builds, or other commands
- **Write**: To create new files if needed

No additional dependencies required.

## Workflow Summary

1. Ask user for issue document path
2. Read and analyze the document
3. Append structured task list to document
4. For each task:
   - Update to `[>]` in document
   - Execute the task
   - Update to `[x]` in document
5. Add completion summary when done

This approach keeps all planning and progress tracking in one place - the issue document itself - making it easy for users to see what's been done and what's remaining.
