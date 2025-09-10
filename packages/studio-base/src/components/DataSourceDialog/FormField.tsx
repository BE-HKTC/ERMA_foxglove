// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Checkbox, CircularProgress, FormControlLabel, FormHelperText, TextField } from "@mui/material";
import { ChangeEvent, useEffect, useRef, useState } from "react";

import { Field } from "@foxglove/studio-base/context/PlayerSelectionContext";

type Props = {
  disabled: boolean;
  field: Field;
  onChange: (newValue: string | undefined) => void;
  onError: (message: string) => void;
};

export function FormField(props: Props): JSX.Element {
  const [error, setError] = useState<string | undefined>();
  const [value, setValue] = useState<string | undefined>(props.field.defaultValue);
  const [checking, setChecking] = useState(false);
  const [reachable, setReachable] = useState<boolean | undefined>(undefined);
  const wsRef = useRef<WebSocket | undefined>();
  const timerRef = useRef<number | undefined>();
  const field = props.field;

  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    setError(undefined);
    const newValue = event.target.value;
    setValue(newValue);

    const maybeError = field.validate?.(newValue);

    if (maybeError instanceof Error) {
      setError(maybeError.message);
      props.onError(maybeError.message);
      return;
    }

    props.onChange(newValue);
  };

  // Clean up any pending websocket/timers
  useEffect(() => {
    return () => {
      if (timerRef.current != undefined) {
        window.clearTimeout(timerRef.current);
      }
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  // Debounced non-blocking connectivity check for WebSocket URLs
  useEffect(() => {
    // Only attempt check if the field looks like a WebSocket URL and there is no validation error
    if (!value || error || (typeof value === "string" && !/^wss?:\/\//.test(value))) {
      setChecking(false);
      setReachable(undefined);
      return;
    }

    setChecking(true);
    setReachable(undefined);

    // Debounce checks to avoid spamming while typing
    const debounce = window.setTimeout(() => {
      // Cleanup any previous socket
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          // ignore
        }
      }

      let settled = false;
      try {
        const ws = new WebSocket(value);
        wsRef.current = ws;

        const done = (ok: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          setChecking(false);
          setReachable(ok);
          try {
            ws.close();
          } catch {
            // ignore
          }
          if (timerRef.current != undefined) {
            window.clearTimeout(timerRef.current);
          }
        };

        ws.onopen = () => done(true);
        ws.onerror = () => done(false);
        ws.onclose = () => {
          // If closed before opening and not otherwise settled, mark unreachable
          if (!settled) {
            done(false);
          }
        };

        // Timeout safeguard (2.5s)
        timerRef.current = window.setTimeout(() => done(false), 2500);
      } catch {
        setChecking(false);
        setReachable(false);
      }
    }, 500);

    return () => {
      window.clearTimeout(debounce);
    };
  }, [value, error]);

  return (
    <div>
      <TextField
        fullWidth
        disabled={props.disabled}
        key={field.label}
        label={field.label}
        error={error != undefined}
        helperText={error}
        FormHelperTextProps={{
          variant: "standard",
        }}
        placeholder={field.placeholder}
        defaultValue={field.defaultValue}
        onChange={onChange}
        variant="outlined"
        InputProps={{
          notched: false,
        }}
        InputLabelProps={{ shrink: true }}
      />
      <FormHelperText>{field.description}</FormHelperText>
      {/** Non-blocking WebSocket reachability indicator (shown for ws:// or wss:// values) */}
      {typeof value === "string" && /^wss?:\/\//.test(value) && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
          {checking ? (
            <CircularProgress size={16} />
          ) : (
            <FormControlLabel
              control={<Checkbox size="small" checked={Boolean(reachable)} disabled />}
              label={reachable === undefined ? "Ready to check" : reachable ? "Server reachable" : "No response"}
            />
          )}
        </div>
      )}
    </div>
  );
}
