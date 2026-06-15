/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/

import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useState,
} from "react";
import { BrowserAuthorizationClient } from "@itwin/browser-authorization";
import { useNavigate } from "@tanstack/react-router";

export enum AuthorizationState {
  Pending,
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
}

const authorizationContext = createContext<AuthorizationContext>({
  client: new BrowserAuthorizationClient({
    clientId: "",
    redirectUri: "",
    scope: "",
  }),
  state: AuthorizationState.Pending,
});

export function useAuthorizationContext() {
  return useContext(authorizationContext);
}

const createAuthClient = (): AuthorizationContext => {
  const client = new BrowserAuthorizationClient({
    scope: import.meta.env.IMJS_AUTH_CLIENT_SCOPES ?? "",
    clientId: import.meta.env.IMJS_AUTH_CLIENT_CLIENT_ID ?? "",
    redirectUri: import.meta.env.IMJS_AUTH_CLIENT_REDIRECT_URI ?? "",
    postSignoutRedirectUri: import.meta.env.IMJS_AUTH_CLIENT_LOGOUT_URI,
    responseType: "code",
    authority: import.meta.env.IMJS_AUTH_AUTHORITY,
  });
  return {
    client,
    state: AuthorizationState.Pending,
  };
};

export function AuthorizationProvider(props: PropsWithChildren<unknown>) {
  const [contextValue, setContextValue] = useState<AuthorizationContext>(() =>
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
    // kick off silent/redirect here (it races the callback and can loop).
    if (window.location.pathname === callbackPathname()) return;
    const signIn = async () => {
      try {
        await authClient.signInSilent();
      } catch {
        await authClient.signInRedirect();
      }
    };

    void signIn();
  }, [authClient]);

  return (
    <authorizationContext.Provider value={contextValue}>
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
