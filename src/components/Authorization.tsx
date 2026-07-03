/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/

import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { BrowserAuthorizationClient } from "@itwin/browser-authorization";
import { useNavigate } from "@tanstack/react-router";

export enum AuthorizationState {
  Pending,
  /** No cached session found — silent sign-in failed. Show the landing page; wait for the
   *  user to opt in via `signIn()` rather than auto-redirecting to Bentley IMS. */
  Unauthenticated,
  Authorized,
}

/** Pathname of the OIDC redirect (e.g. "/signin-callback" locally, "/acs-demo/signin-callback" on Pages). */
function callbackPathname(): string {
  try {
    return new URL(import.meta.env.IMJS_AUTH_CLIENT_REDIRECT_URI ?? "").pathname;
  } catch {
    return "/signin-callback";
  }
}

export interface AuthorizationContext {
  client: BrowserAuthorizationClient;
  state: AuthorizationState;
  /** Explicit, user-initiated sign-in (landing page "Operational Twin" card). Tries a silent
   *  refresh first, falling back to the interactive IMS redirect — the same sequence the app
   *  used to fire automatically on mount. */
  signIn: () => Promise<void>;
}

const authorizationContext = createContext<AuthorizationContext>({
  client: new BrowserAuthorizationClient({
    clientId: "",
    redirectUri: "",
    scope: "",
  }),
  state: AuthorizationState.Pending,
  signIn: async () => {},
});

export function useAuthorizationContext() {
  return useContext(authorizationContext);
}

type ClientState = Omit<AuthorizationContext, "signIn">;

const createAuthClient = (): ClientState => {
  const client = new BrowserAuthorizationClient({
    scope: import.meta.env.IMJS_AUTH_CLIENT_SCOPES ?? "",
    clientId: import.meta.env.IMJS_AUTH_CLIENT_CLIENT_ID ?? "",
    redirectUri: import.meta.env.IMJS_AUTH_CLIENT_REDIRECT_URI ?? "",
    postSignoutRedirectUri: import.meta.env.IMJS_AUTH_CLIENT_LOGOUT_URI,
    responseType: "code",
    authority: import.meta.env.IMJS_AUTH_AUTHORITY,
  });
  // The library's default non-interactive (silent) check waits up to 10s for a hidden-iframe
  // round trip to the authority before giving up — both signIn()'s call into signInRedirect()
  // and the mount-time silent probe pay that cost. Trim it so a "no session" click reaches the
  // visible interactive redirect quickly rather than stalling near a full 10s. setAdvancedSettings
  // merges (spreads) onto the settings already derived from the config above, so a partial object
  // is all that's applied at runtime even though its declared type asks for the full settings shape.
  client.setAdvancedSettings({
    silentRequestTimeoutInSeconds: 6,
  } as Parameters<typeof client.setAdvancedSettings>[0]);
  return {
    client,
    state: AuthorizationState.Pending,
  };
};

export function AuthorizationProvider(props: PropsWithChildren<unknown>) {
  const [contextValue, setContextValue] = useState<ClientState>(() =>
    createAuthClient()
  );

  const authClient = contextValue.client;
  useEffect(() => {
    return authClient.onAccessTokenChanged.addListener(() =>
      setContextValue((prev) => ({
        ...prev,
        state: AuthorizationState.Authorized,
      }))
    );
  }, [authClient]);

  useEffect(() => {
    // On the OIDC callback route, the SignInRedirect component completes auth — don't also
    // kick off silent sign-in here (it races the callback and can loop).
    if (window.location.pathname === callbackPathname()) return;
    let cancelled = false;
    const trySilent = async () => {
      try {
        // Quiet check for a cached/refreshable session — never prompts or redirects the
        // browser. On success, onAccessTokenChanged (above) flips state to Authorized and the
        // app boots straight into the viewer, same as before this change.
        await authClient.signInSilent();
      } catch {
        // No cached session: land on the pre-auth landing page instead of auto-firing the
        // interactive IMS redirect. The user opts in via the "Operational Twin" card, which
        // calls the `signIn` context method below.
        if (!cancelled) {
          setContextValue((prev) => ({
            ...prev,
            state: AuthorizationState.Unauthenticated,
          }));
        }
      }
    };

    void trySilent();
    return () => {
      cancelled = true;
    };
  }, [authClient]);

  const signIn = useCallback(async () => {
    // Show the Pending spinner immediately so the click has visible feedback (signInRedirect's
    // own non-interactive check below can take several seconds against the IMS authority).
    setContextValue((prev) => ({ ...prev, state: AuthorizationState.Pending }));
    try {
      // signInRedirect() already attempts a non-interactive (silent) sign-in first and only
      // falls back to the interactive top-window redirect if that fails — see its docstring.
      // Calling signInSilent() here first (as this used to) duplicates that same silent
      // attempt, doubling the wait before the visible redirect ever fires. Call it directly.
      await authClient.signInRedirect();
    } catch {
      // Redirect couldn't be initiated (e.g. config/network error) — fall back to the landing
      // page instead of leaving the user stuck on the Pending spinner with no way to retry.
      setContextValue((prev) => ({ ...prev, state: AuthorizationState.Unauthenticated }));
    }
  }, [authClient]);

  return (
    <authorizationContext.Provider value={{ ...contextValue, signIn }}>
      {props.children}
    </authorizationContext.Provider>
  );
}

export function SignInRedirect() {
  const { client } = useAuthorizationContext();
  const navigate = useNavigate();

  useEffect(() => {
    // Process the OIDC code, then SPA-navigate to the app root. Using the router (not
    // window.location) keeps the in-memory token alive — a full reload would drop it and loop.
    // Works for both localhost ("/") and Pages ("/acs-demo/") via the router basepath.
    void client.handleSigninCallback().finally(() => {
      if (window.self !== window.top) return; // silent-renew iframe: do nothing
      void navigate({
        to: "/",
        search: {
          iTwinId: import.meta.env.IMJS_ITWIN_ID as string,
          iModelId: import.meta.env.IMJS_IMODEL_ID as string,
        },
      });
    });
  }, [client, navigate]);

  return (
    <div style={{ padding: 24, fontFamily: "Segoe UI, system-ui, sans-serif", color: "#93a1b0" }}>
      Completing sign-in…
    </div>
  );
}
