# Deploying the demo to GitHub Pages

This repo is set up to auto-build and deploy to GitHub Pages on every push to `master`
(`.github/workflows/deploy.yml`). Site URL: **https://meta-dev-coder.github.io/acs-demo/**

## One-time setup (you must do these — they're outside this machine)

1. **Push the repo** (this machine's SSH key isn't authorized for `meta-dev-coder`, so push from
   your own machine / with your own auth):
   ```bash
   cd acs-i595-twin
   git remote add origin git@github.com:meta-dev-coder/acs-demo.git   # or HTTPS
   git push -u origin master
   ```
   (HTTPS alt: `git remote add origin https://github.com/meta-dev-coder/acs-demo.git`)

2. **Enable Pages**: GitHub repo → Settings → Pages → **Source: GitHub Actions**.

3. **Add the Pages redirect URI to the OIDC client** (or sign-in fails on the hosted site):
   developer.bentley.com → My Apps → **APP-BST409** → add redirect URI
   `https://meta-dev-coder.github.io/acs-demo/signin-callback` and post-logout
   `https://meta-dev-coder.github.io/acs-demo/`. Keep the localhost ones for local dev.

## IMPORTANT caveats

- **Who can use the hosted site:** the app loads the customer model + reality mesh, which require
  a **Bentley login with access to the BST409 / COPY iTwin** (i.e. Mike's account). A random
  public visitor cannot load the 3D data. So the Pages URL is for the **team to present from**
  (signed in), not public self-serve.
- **Public exposure:** a public Pages site serves the built JS, which contains the iTwin/iModel
  GUIDs from `.env.production`. These are not credentials, but if referencing the customer iTwin id
  publicly is a concern, make the repo **private** (Pages needs GitHub Pro for private) or move the
  GUIDs to **GitHub Actions Variables** and drop `.env.production` from git.

## Local dev (unchanged)

```bash
nvm use 22
npm install
npm start          # http://localhost:3000  (uses .env, base "/")
# or auto-restarting:  bash scripts/dev.sh
```
