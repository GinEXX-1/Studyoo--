# Studyoo Design QA

- source visual truth: `/Users/ginex/Downloads/Studyoo 20260714.zip`（`Studyoo.dc.html` 与 `.thumbnail`）
- implementation: `http://localhost:4173/`
- viewports: 1007×862 desktop, 390×844 mobile
- states reviewed: login, workbench, library list/detail, parser, profile learning path, practice entry and answer composer
- comparison evidence: source thumbnail and design-package screens were inspected beside in-app browser captures at matching desktop/mobile states; focused comparisons covered the hero scene, library covers/detail, parser composer, mobile navigation, profile graph and login screen

## Resolved findings

- [P1] Mobile navigation was anchored to the transformed header and scrolled incorrectly.
  - Fix: moved it to a true fixed bottom navigation layer and reserved safe-area content space.
- [P1] Mobile library showed list and detail together.
  - Fix: list is the default state; tapping a collection opens a dedicated detail state with a back action.
- [P1] Long profile names expanded the mobile grid and clipped the learning-path canvas.
  - Fix: constrained all profile grid tracks, allowed nickname wrapping and verified a 305px graph canvas inside the 390px viewport.
- [P1] Backend rejected the Vite preview origin, breaking logout and authentication QA.
  - Fix: added localhost:4173 to the default/example CORS allow-list and verified register, logout and login.
- [P2] Practice math keys wrapped into a tall block on mobile.
  - Fix: changed the keyboard to a single horizontally scrollable row; the submit action remains visible at 390×844.
- [P2] Selected library covers used a heavy black outline and generic text-only artwork.
  - Fix: removed the selected outline and added distinct subject cover motifs.
- [P2] Profile learning path lacked the tree visualization from the original project.
  - Fix: added an interactive responsive canvas graph with stage selection and a primary learning action.

## Interaction and responsive verification

- 390×844: no horizontal overflow on workbench, library, parser, profile or practice.
- Hero learning cards continuously animate; the hover rule pauses the hovered card.
- Mobile library list → collection detail → grading mode → practice question works end to end.
- Parser suggestions, subject selector, text/image mode and composer enablement work at mobile width.
- Learning-path nodes are clickable and update the selected stage detail.
- Login CTA is fully visible above the fold; register → logout → login was verified with a disposable QA account, then cleaned up.
- Latest app reload produced no new application console errors. Earlier CORS errors were reproduced, fixed and retested.

## Automated verification

- `npm run build`: passed (111 modules).
- `npm run smoke:backend`: passed full minimal backend chain.
- `npm run test:practice-workflow --workspace backend`: passed.
- `npm run test:ownership --workspace backend`: passed.
- `git diff --check`: passed.

## Follow-up polish

- The production build reports a non-blocking JavaScript chunk-size warning; route-level code splitting can be added later if load-performance work becomes a priority.

final result: passed
