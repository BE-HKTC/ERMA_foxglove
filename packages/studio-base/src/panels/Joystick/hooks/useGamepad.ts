// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2024 Joshua Newans
//   Copyright 2022 Ryan Govostes
//   Licensed under the MIT license (see LICENSE file in the original project)

import { useCallback, useEffect, useRef } from "react";

export function useGamepad({
  didConnect,
  didDisconnect,
  didUpdate,
}: {
  didConnect: (gamepad: Gamepad) => void;
  didDisconnect: (gamepad: Gamepad) => void;
  didUpdate: (gamepad: Gamepad) => void;
}): void {
  const animationRequestId = useRef<number>(0);

  const onAnimationFrame = useCallback(() => {
    let gamepadCount = 0;

    for (const gamepad of navigator.getGamepads()) {
      if (gamepad == null) {
        continue;
      }
      didUpdate(gamepad);
      gamepadCount += 1;
    }

    animationRequestId.current =
      gamepadCount === 0 ? 0 : window.requestAnimationFrame(onAnimationFrame);
  }, [didUpdate]);

  useEffect(() => {
    if (animationRequestId.current !== 0) {
      window.cancelAnimationFrame(animationRequestId.current);
    }

    animationRequestId.current = window.requestAnimationFrame(onAnimationFrame);
  }, [onAnimationFrame]);

  const onConnect = useCallback(
    (event: GamepadEvent) => {
      didConnect(event.gamepad);

      if (animationRequestId.current === 0) {
        animationRequestId.current = window.requestAnimationFrame(onAnimationFrame);
      }
    },
    [didConnect, onAnimationFrame],
  );

  const onDisconnect = useCallback(
    (event: GamepadEvent) => {
      didDisconnect(event.gamepad);
    },
    [didDisconnect],
  );

  useEffect(() => {
    window.addEventListener("gamepadconnected", onConnect);
    window.addEventListener("gamepaddisconnected", onDisconnect);
    return () => {
      window.removeEventListener("gamepadconnected", onConnect);
      window.removeEventListener("gamepaddisconnected", onDisconnect);
    };
  }, [onConnect, onDisconnect]);

  useEffect(() => {
    return () => {
      if (animationRequestId.current !== 0) {
        window.cancelAnimationFrame(animationRequestId.current);
        animationRequestId.current = 0;
      }
    };
  }, []);
}
