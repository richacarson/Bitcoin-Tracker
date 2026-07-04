// Where the dashboard's API lives.
//  - Served by the app itself (local `npm start`, or a custom domain on the
//    edge function): leave empty — same-origin relative URLs work.
//  - Static hosting (GitHub Pages): scripts/build-pages.mjs overwrites this
//    with the Supabase edge-function URL.
window.BTC_API_BASE = '';
