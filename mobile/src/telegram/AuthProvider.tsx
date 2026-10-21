// Who is signed in: checked once at start from the saved session, then set by the sign-in screen.
import { createContext, use, useCallback, useEffect, useState, type ReactNode } from "react";
import type { Api } from "telegram";

import { authErrorText } from "../../../core.js";
import { currentUser, signOut as tgSignOut } from "./client";
import { stopCloud } from "../store/cloud";
import { forgetAvatars } from "./avatars";
import { resetChats } from "./useChats";

type Auth = {
  state: "checking" | "out" | "in" | "error";
  me: Api.User | null;
  error?: string;
  refresh: () => Promise<Api.User | null>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<Auth | null>(null);
export const useAuth = () => use(AuthContext)!;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Auth["state"]>("checking");
  const [me, setMe] = useState<Api.User | null>(null);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const user = await currentUser();
      setMe(user);
      setState(user ? "in" : "out");
      setError(undefined);
      return user;
    } catch (err) {
      setError(authErrorText(err));
      setState("error");
      return null;
    }
  }, []);

  useEffect(() => {
    currentUser()
      .then((user) => {
        setMe(user);
        setState(user ? "in" : "out");
      })
      .catch((err) => {
        setError(authErrorText(err));
        setState("error");
      });
  }, []);

  const signOut = useCallback(async () => {
    await stopCloud(); // the last changes go to the web version's copy first
    await tgSignOut();
    resetChats();
    forgetAvatars();
    setMe(null);
    setState("out");
  }, []);

  return <AuthContext value={{ state, me, error, refresh, signOut }}>{children}</AuthContext>;
}
