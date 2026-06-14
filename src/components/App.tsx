/*---------------------------------------------------------------------------------------------
 * Copyright (c) Bentley Systems, Incorporated. All rights reserved.
 * See LICENSE.md in the project root for license terms and full copyright notice.
 *--------------------------------------------------------------------------------------------*/

import { Viewer } from "@itwin/web-viewer-react";
import { type IModelConnection } from "@itwin/core-frontend";
import { useCallback } from "react";
import { selectionStorage } from "../selectionStorage";
import { useAuthorizationContext } from "./Authorization";
import { configureViewport, onIModelConnected } from "../scene/init";
import { Shell } from "../app/Shell";

interface AppProps {
  iTwinId: string;
  iModelId: string;
  changesetId?: string;
}

const viewCreatorOptions = { viewportConfigurer: configureViewport };

export function App({ iTwinId, iModelId, changesetId }: AppProps) {
  const { client: authClient } = useAuthorizationContext();

  const handleConnected = useCallback(async (iModel: IModelConnection) => {
    onIModelConnected(iModel);
  }, []);

  const viewer = (
    <Viewer
      iTwinId={iTwinId}
      iModelId={iModelId}
      changeSetId={changesetId}
      authClient={authClient}
      viewCreatorOptions={viewCreatorOptions}
      enablePerformanceMonitors={false}
      onIModelConnected={handleConnected}
      uiProviders={[]}
      defaultUiConfig={{
        hideNavigationAid: false,
        hideStatusBar: true,
        hideToolSettings: true,
      }}
      selectionStorage={selectionStorage}
    />
  );

  return <Shell viewer={viewer} />;
}
