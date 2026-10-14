import { getRootRecoveryTarget } from "./rootRecovery.js";

const target = getRootRecoveryTarget(window.location);
if (target) window.location.replace(target);
