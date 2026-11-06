---
name: write-failing-test
description: Use when planning a step that has no test yet, to define a "done when" test that fails before the change and passes after.
---
# Write a failing test first

1. Find the existing test file nearest the code the step changes and copy its style.
2. Write one test for the behaviour the step adds. It must fail on the current code for the right reason.
3. Run it and confirm the failure message names the missing behaviour, not a typo or an import error.
4. Use that test's command as the step's "done when", and list the test file as protected for later steps.
