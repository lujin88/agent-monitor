# Agent Monitor design review

## Design intent

The page should behave like a quiet action center: attention requests first, completed work easy to scan, live work visible without dominating the page, and usage available as supporting context. The visual language should stay restrained, editorial, and low-decoration.

## Evidence reviewed

- Desktop: `screenshots/review-agent-monitor-before-desktop-1280.png`
- Tablet: `screenshots/review-agent-monitor-before-tablet-768.png`
- Mobile: `screenshots/review-agent-monitor-before-mobile-375.png`
- Updated desktop: `screenshots/review-agent-monitor-after-desktop-1280.png`
- Updated tablet: `screenshots/review-agent-monitor-after-tablet-768.png`
- Updated mobile Review view: `screenshots/review-agent-monitor-after-mobile-375.png`

## Findings and changes

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| High | Ready to review rows | Every row repeated a green check and the word “Ready”; the label looked like passive status even though it removed the item. | One quiet check control with a 36px hit target, tooltip, and task-specific accessible label. | Removes visual repetition and makes the interaction more honest. |
| High | 768px layout | The two-column action area and three-column usage card were compressed until titles, labels, and progress bars competed. | Portrait tablet uses the same clear Action / Review / Running switcher as mobile; usage remains a readable three-column summary. | Preserves hierarchy instead of shrinking desktop composition beyond its useful range. |
| Medium | Empty Running state | An empty panel occupied almost the same height as live work. | The empty state collapses to a compact confirmation strip on desktop. | Empty state should reassure, not become the page’s largest object. |
| Medium | Action vs. Review headings | Only Review had explanatory copy, so the two columns started on different baselines. | Added matching explanatory copy under Needs your action. | Restores symmetry and makes the decision model explicit. |
| Medium | Review pagination | The constrained desktop panel showed one completed item per page. | The adjusted vertical allocation now shows the two related Codex items together. | Grouped work should be understood as a group. |
| Low | Icon controls | Collapse and dismiss targets were visually small. | Interactive boxes are at least 36px while their glyphs remain visually light. | Improves pointer and touch use without adding visual weight. |
| Low | Secondary text | Small muted labels narrowly missed WCAG contrast. | Darkened the shared muted color from `#627797` to `#5e7190`. | Keeps the same color character while clearing the contrast threshold. |

## What already worked

- The red / green / blue state system is easy to learn and consistently applied.
- Brand marks are recognizable without competing with task titles.
- The restrained off-white surface, subtle borders, and limited shadows suit an always-open dashboard.
- Running cards already adapt cleanly for one, two, or three agents.
- The mobile section switcher is the right information architecture for a narrow screen.

## Considered but not added

- **Dark mode:** useful later, but adding it now would double the surface-validation work and was not required for this focused refinement.
- **Row-level overflow menus:** unnecessary for the current single “mark reviewed” action.
- **Extra animation:** avoided because this is a monitoring surface; motion should be reserved for real state changes.

## Verification

- Checked at 1280×800, 768×1024, and 375×812.
- Inline JavaScript parses successfully.
- Final Lighthouse mobile snapshot: Accessibility 100, Best Practices 100, SEO 100, Agentic Browsing 100; all 32 audited checks passed.
- Remix Icon references used by the interface are present in the vendored icon font declarations.

## Verdict

The revised page now reads as one system rather than a collection of independently compressed cards. The main remaining product question is not visual: whether completed tasks should persist until explicitly reviewed or expire automatically after a retention period.

## Running-state follow-up

### Key screens

- One task: `screenshots/running-1-task.png`
- Two tasks: `screenshots/running-2-tasks.png`
- Three tasks: `screenshots/running-3-tasks.png`

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| High | Running cards | In a short desktop viewport, the card shrank to about 97px and Flex reduced the task title to 0px height. | Running receives 220px in the compact desktop composition; task titles cannot flex-shrink and may use two lines. | A live task without its title is unreadable and breaks the primary monitoring job. |
| Medium | Running layout | Only the single-card state had been visually exercised. | One task is capped at 720px; two tasks use two equal columns; three tasks use three equal columns; narrow screens paginate two cards per page. | Each task count now has an intentional composition instead of relying on accidental grid behavior. |
| Medium | Usage versus Running | Usage retained 170px while live work was compressed. | Compact desktop usage is 130px and Running is 220px. | Live work has higher information priority than account limits. |
| Low | Brand sizing | Equal image-box dimensions produced unequal perceived logo sizes because each SVG has different internal whitespace. | Shared containers and type sizes remain equal, with small source-specific optical corrections to the logo artwork. | Optical equality is more consistent than identical numeric scaling. |

### Considered but rejected

| Location | Candidate | Rejected because |
| --- | --- | --- |
| Running cards | Horizontal carousel on desktop | One to three tasks fit without hiding information; a carousel would add navigation cost. |
| Usage section | Collapse usage entirely while tasks run | Usage is still useful context and fits in the 130px summary treatment. |
| Running title | Force every title to one line | It would recreate truncation for longer task names; two lines are safer and still compact. |
