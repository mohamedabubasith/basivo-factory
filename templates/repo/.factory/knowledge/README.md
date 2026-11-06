---
title: How to write knowledge docs
summary: Put decisions, conventions and runbooks here; agents search them with kb_search, they are never pushed.
reviewed: 2026-11-06
---
# Knowledge base

One Markdown file per decision, convention or runbook. Optional frontmatter:

- `title` and `summary`: what search results show
- `reviewed: YYYY-MM-DD`: when a person last confirmed it is still true
- `sources: [paths]`: the code it describes

A doc counts as stale when it was never reviewed, was reviewed over 180 days ago, or its sources changed after
review. Agents see the stale flag and check the code before trusting the doc.
