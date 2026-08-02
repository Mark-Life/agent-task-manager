import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@workspace/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card";
import { Input } from "@workspace/ui/components/input";
import { Label } from "@workspace/ui/components/label";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { signIn } from "@/auth/client";

/** Where a signed-in operator belongs: the board. */
const HOME_PATH = "/";

/**
 * What the sign-in endpoint's refusals mean.
 *
 * A wrong password is the common case and has to say so — an account that
 * exists and one that does not are deliberately the same sentence here, because
 * telling them apart is how a stranger learns which addresses are real. The
 * rest are configuration faults on the server side, and naming them is what
 * saves somebody an hour in the logs.
 */
const REFUSALS: Record<string, string> = {
  EMAIL_PASSWORD_DISABLED: "The server has password sign-in switched off.",
  INVALID_EMAIL: "That is not an email address.",
  INVALID_EMAIL_OR_PASSWORD: "That email and password do not match an account.",
  INVALID_ORIGIN: "The server does not trust this address.",
  USER_NOT_FOUND: "That email and password do not match an account.",
};

const FALLBACK = "Sign-in did not go through.";

/**
 * A sentence for whatever came back, or null when nothing did.
 *
 * Better Auth answers a refusal in the body rather than by throwing, so the
 * mutation below throws it on itself and the shape arriving here is either that
 * body or a genuine transport exception. Both are read defensively: a login
 * screen that crashes while explaining a failure is worse than the failure.
 */
const refusalText = (error: unknown) => {
  if (error === null || error === undefined) {
    return null;
  }
  if (typeof error === "object" && "code" in error) {
    const code = typeof error.code === "string" ? error.code : undefined;
    const known = code === undefined ? undefined : REFUSALS[code];
    if (known !== undefined) {
      return known;
    }
  }
  if (typeof error === "object" && "message" in error) {
    return typeof error.message === "string" && error.message !== ""
      ? error.message
      : FALLBACK;
  }
  return FALLBACK;
};

/**
 * The only unauthenticated screen.
 *
 * There is no link to register: sign-up is disabled on the server, so an
 * account arrives by being seeded and a form offering otherwise would be a
 * promise nothing keeps. The cache is emptied on the way in because whatever it
 * holds was read for a session that has just been replaced.
 */
export const SignIn = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const submit = useMutation({
    mutationFn: async (credentials: {
      readonly email: string;
      readonly password: string;
    }) => {
      const { error } = await signIn.email(credentials);
      if (error) {
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.clear();
      return navigate({ replace: true, to: HOME_PATH });
    },
  });

  const { mutate } = submit;
  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      mutate({ email: email.trim(), password });
    },
    [email, mutate, password]
  );

  const onEmail = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setEmail(event.target.value),
    []
  );
  const onPassword = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setPassword(event.target.value),
    []
  );

  const refused = refusalText(submit.error);

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            The operator dashboard. Accounts are provisioned, not registered.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-4" onSubmit={onSubmit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="sign-in-email">Email</Label>
              <Input
                autoComplete="username"
                id="sign-in-email"
                onChange={onEmail}
                required
                type="email"
                value={email}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="sign-in-password">Password</Label>
              <Input
                autoComplete="current-password"
                id="sign-in-password"
                onChange={onPassword}
                required
                type="password"
                value={password}
              />
            </div>
            {refused === null ? null : (
              <p className="text-destructive text-xs">{refused}</p>
            )}
            <Button
              disabled={
                submit.isPending || email.trim() === "" || password === ""
              }
              type="submit"
            >
              {submit.isPending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
};
