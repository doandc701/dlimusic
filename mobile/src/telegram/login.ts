// Sign-in, like the web's: phone → code (sent to the Telegram app) → two-step password if the account has one.
// GramJS' client.start asks for each answer; the screen gives them with `answer()`.
import { authErrorText } from "../../../core.js";
import { MOCK, mockParam } from "../mock";
import { API_HASH, API_ID, getClient, saveSession } from "./client";

export type LoginStep = "phone" | "code" | "password" | "done";

export type LoginEvents = {
  onStep: (step: LoginStep) => void;
  onError: (message: string) => void;
};

export class LoginFlow {
  private waiting: { resolve: (v: string) => void; reject: (e: Error) => void } | null = null;
  private cancelled = false;

  constructor(private events: LoginEvents) {}

  async start() {
    if (MOCK) {
      this.events.onStep((mockParam("step") as LoginStep) || "phone");
      return;
    }
    const client = await getClient();
    try {
      await client.start({
        phoneNumber: () => this.ask("phone"),
        phoneCode: () => this.ask("code"),
        password: () => this.ask("password"),
        onError: async (err: Error & { seconds?: number; errorMessage?: string }) => {
          if (this.cancelled) return true; // abandoned: stop quietly
          this.events.onError(authErrorText(err));
          // Telegram's wait after too many codes, or a refused number: stop (back to the phone step); a wrong code
          // or password is asked again
          return (
            !!err.seconds ||
            /FLOOD|PHONE_NUMBER_INVALID|PHONE_NUMBER_BANNED/.test(err.errorMessage || err.message || "")
          );
        },
      } as never);
      if (this.cancelled) return;
      await saveSession();
      this.events.onStep("done");
    } catch (err) {
      if (this.cancelled) return;
      this.events.onError(authErrorText(err));
      this.events.onStep("phone");
    }
  }

  private ask(step: Exclude<LoginStep, "done">) {
    if (!this.cancelled) this.events.onStep(step);
    return new Promise<string>((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  /** The phone number, code or password typed on the screen. */
  answer(value: string) {
    const w = this.waiting;
    this.waiting = null;
    w?.resolve(value);
  }

  cancel() {
    this.cancelled = true;
    this.waiting?.reject(new Error("cancelled"));
    this.waiting = null;
  }
}

export const apiReady = () => Boolean(API_ID && API_HASH);
