UI standard (applies to every user-facing change):
- Build on the app's existing layouts, components and styles. Never add a hand-written <style> block,
  inline styles or unstyled HTML; load CSS the way existing pages do.
- New pages must look finished and match the rest of the app: same spacing, type scale, colours, icons
  and page structure (title, description, content in cards or sections). Inside an existing app,
  consistency with its design system wins over novelty.
- Cover the states: empty (a helpful message, not a blank area), validation errors next to their fields,
  success feedback, and pending/disabled buttons while a form submits.
- Forms have labels, sensible input types and placeholders; destructive actions ask for confirmation.
- Works at 390 px wide (phone) and on desktop, and in dark mode when the app supports it.
- Add a link to new pages where users would look for them (navigation, sidebar or a related page).
- The frontend-design skill is available if you need design guidance.
