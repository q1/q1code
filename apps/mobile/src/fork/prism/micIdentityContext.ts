import type { MicIdentityTokenSource } from "@t3tools/client-runtime/fork";
import { createContext } from "react";

export const MicPrismTokenContext = createContext<MicIdentityTokenSource | undefined>(undefined);
