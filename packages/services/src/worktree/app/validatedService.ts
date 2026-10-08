import type { IWorktreeService } from "../contract.js";
import { worktreeRequests as schemas } from "../domain/requests.js";
import { worktreeIntegrationPreflightSchema } from "@lcode/shared";

export function validateWorktreeRequests(service: IWorktreeService): IWorktreeService {
  return {
    async getCapabilities(params) {
      return service.getCapabilities(schemas.getCapabilities.parse(params));
    },
    async prepare(params) {
      return service.prepare(schemas.prepare.parse(params));
    },
    async getBinding(params) {
      return service.getBinding(schemas.getBinding.parse(params));
    },
    async list(params) {
      return service.list(schemas.list.parse(params));
    },
    async integrate(params) {
      return service.integrate(schemas.integrate.parse(params));
    },
    async getIntegrationPreflight(params) {
      return worktreeIntegrationPreflightSchema.parse(
        await service.getIntegrationPreflight(schemas.getIntegrationPreflight.parse(params)),
      );
    },
    async continueIntegration(params) {
      return service.continueIntegration(schemas.continueIntegration.parse(params));
    },
    async getIntegration(params) {
      return service.getIntegration(schemas.getIntegration.parse(params));
    },
    async publishIntegration(params) {
      return service.publishIntegration(schemas.publishIntegration.parse(params));
    },
    async archive(params) {
      return service.archive(schemas.archive.parse(params));
    },
    async restore(params) {
      return service.restore(schemas.restore.parse(params));
    },
    async acquireCheckout(params) {
      return service.acquireCheckout(schemas.acquireCheckout.parse(params));
    },
    async releaseCheckout(params) {
      return service.releaseCheckout(schemas.releaseCheckout.parse(params));
    },
  };
}
