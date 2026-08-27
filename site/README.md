# Documentation site

This directory contains the dependency-free public website for AI App Assistant:

- `index.html`: product overview;
- `demo.html`: faithful interactive simulation of the shipped UI flow;
- `integrations.html`: connector map and end-to-end setup guide.

The content is deliberately generic. Do not add customer names, real application screenshots, business data, credentials or source material copied from private integrations.

## Local preview

Serve this directory with any static file server and open `index.html` through HTTP.

## Publishing

The `deploy-pages.yml` workflow publishes this directory to GitHub Pages after a push to `main`. In the repository settings, set **Pages → Build and deployment → Source** to **GitHub Actions** once.
