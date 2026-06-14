/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/

import "./Routes.css";
import {
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  AuthorizationState,
  SignInRedirect,
  useAuthorizationContext,
} from "./Authorization";
import { RootLayout } from "./RootLayout";
import { ProgressLinear } from "@itwin/itwinui-react";
import { App } from "./App";
import { TokenView } from "./TokenView";

const rootRoute = createRootRoute({
  component: RootLayout,
});

interface IndexSearchParams {
  iTwinId: string;
  iModelId: string;
  changesetId?: string;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  validateSearch: (search: Record<string, unknown>): IndexSearchParams => {
    const iTwinId =
      (search.iTwinId as string | undefined) ?? import.meta.env.IMJS_ITWIN_ID;
    const iModelId =
      (search.iModelId as string | undefined) ?? import.meta.env.IMJS_IMODEL_ID;
    const changesetId = search.changesetId as string | undefined;
    if (!iTwinId || !iModelId) {
      throw new Error(
        "Please add a valid iTwin ID and iModel ID in the .env file and restart the application or add it to the `iTwinId`/`iModelId` query parameter in the url and refresh the page. See the README for more information."
      );
    }
    return {
      iTwinId,
      iModelId,
      changesetId,
    };
  },
  path: "/",
  component: function Index() {
    const { iTwinId, iModelId, changesetId } = indexRoute.useSearch();
    const { state } = useAuthorizationContext();

    return (
      <div className="viewer-container">
        {state === AuthorizationState.Pending ? (
          <div className="centered">
            <div className="signin-content">
              <ProgressLinear labels={["Loading..."]} />
            </div>
          </div>
        ) : (
          <App
            iTwinId={iTwinId}
            iModelId={iModelId}
            changesetId={changesetId}
          />
        )}
      </div>
    );
  },
});

const signinRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signin-callback",
  component: SignInRedirect,
});

// Dev helper: /token shows the signed-in user's access token (for the replica scripts).
const tokenRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/token",
  component: TokenView,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  signinRedirectRoute,
  tokenRoute,
]);

// Under GitHub Pages the app is served from /<repo>/ (vite BASE_URL). Match the router to it
// so /signin-callback resolves under the base. Local dev BASE_URL is "/" -> no basepath.
const basepath = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");

export const router = createRouter({
  routeTree,
  basepath: basepath || undefined,
  defaultPreload: "intent",
  scrollRestoration: true,
});