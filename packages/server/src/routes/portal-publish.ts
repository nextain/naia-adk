import type { FastifyError, FastifyPluginCallback, FastifyReply, FastifyRequest } from "fastify"
import crypto from "node:crypto"
import { PublishService } from "../publish-service.js"
import { PublishError } from "../publish-bundle.js"
import { PublishIdentityError, requirePublishIdentity, requireApprover } from "../publish-identity.js"
import type { PublishFault } from "../publish-store.js"

interface PublishRouteOptions { fault?: PublishFault }

export const portalPublishRoutes: FastifyPluginCallback<PublishRouteOptions> = (app, options, done) => {
  let service: PublishService | undefined
  const getService = () => service ??= new PublishService((app as any).adkRoot, process.env, (app as any).folderCheckContext ?? undefined, options.fault)
  const sendError = (request: FastifyRequest, reply: FastifyReply, error: any) => {
    const reportedStatus = typeof error.status === "number" ? error.status : typeof error.statusCode === "number" ? error.statusCode : 503
    const status = reportedStatus >= 400 && reportedStatus <= 599 ? reportedStatus : 503
    const safe = error instanceof PublishError || error.name === "PublishIdentityError"
    const code = safe ? error.code : "PUBLISH_UNAVAILABLE"
    return reply.code(status).send({ ok: false, code, message: safe ? error.message : "게시 확인 처리를 마치지 못했습니다", retryable: status >= 500, request_id: request.id ?? crypto.randomUUID(), operation_id: error.operation_id ?? null, issues: error.issues ?? (error.field ? [{ field: error.field }] : []) })
  }
  // 본문 파싱 실패도 게시 응답의 캐시·오류 계약을 따른다.
  app.addHook("onRequest", async (_request, reply) => { reply.header("Cache-Control", "no-store") })
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const failure = error.code?.startsWith("FST_ERR_CTP_")
      ? new PublishError(error.statusCode ?? 400, "REQUEST_INVALID", "요청 본문을 확인해 주세요")
      : error
    return sendError(request, reply, failure)
  })
  const approvalGate = async (request: FastifyRequest, reply: FastifyReply) => {
    if (process.env.PUBLISH_GATEWAY_OVERWRITE_CONFIRMED !== "1") {
      try { requireApprover("") } catch (error) { return sendError(request, reply, error) }
    }
  }
  const run = async (request: FastifyRequest, reply: FastifyReply, write: boolean, action: (service: PublishService, actor: string) => Promise<any>, approval = false) => {
    try {
      // 승인 권한은 원시 URL 표기와 무관하게 실제 선택된 처리기에서 검사한다.
      if (approval && process.env.PUBLISH_GATEWAY_OVERWRITE_CONFIRMED !== "1") requireApprover("")
      const actor = requirePublishIdentity(request, process.env, write)
      if (approval) requireApprover(actor)
      const result = await action(getService(), actor)
      if (result && "status" in result && "body" in result) return reply.code(result.status).send(result.body)
      return reply.send(result)
    } catch (error: any) {
      return sendError(request, reply, error)
    }
  }
  const params = (request: FastifyRequest) => request.params as { slug: string; revision_id: string; asset_hash: string; operation_id: string }
  const body = (request: FastifyRequest, keys: string[]): any => {
    const value = request.body as any
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => typeof value[key] !== "string" || !value[key])) throw new PublishError(400, "REQUEST_INVALID", "요청 값을 확인해 주세요")
    for (const key of keys) {
      const pattern = key === "review_id" ? /^review_[a-f0-9]{64}$/ : key === "revision_id" ? /^rev_[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/
      if (!pattern.test(value[key])) throw new PublishError(400, "REQUEST_INVALID", "요청 지문을 확인해 주세요")
    }
    return value
  }
  const key = (request: FastifyRequest): string => {
    let count = 0
    for (let i = 0; i < request.raw.rawHeaders.length; i += 2) if (request.raw.rawHeaders[i].toLowerCase() === "idempotency-key") count++
    const value = request.headers["idempotency-key"]
    if (count !== 1 || typeof value !== "string") throw new PublishError(400, "IDEMPOTENCY_KEY_REQUIRED", "단일 멱등키가 필요합니다")
    return value
  }
  app.get("/document", (request, reply) => run(request, reply, false, (service) => {
    const query = request.query as Record<string, unknown>
    if (Object.keys(query).some((name) => name !== "source" && name !== "path") || typeof query.source !== "string" || !query.source || typeof query.path !== "string" || !query.path) throw new PublishError(400, "REQUEST_INVALID", "문서 출처와 경로를 확인해 주세요")
    return service.document(query.source, query.path)
  }))
  app.get("/review-todos", (request, reply) => run(request, reply, false, async (service, actor) => {
    try { return await service.todos(actor) } catch (error) {
      if (error instanceof PublishError || error instanceof PublishIdentityError) throw error
      throw new PublishError(503, "REVIEW_TASK_READ_FAILED", "게시 확인 할 일을 불러오지 못했습니다")
    }
  }))
  app.get("/operations/:operation_id", (request, reply) => run(request, reply, false, (service, actor) => service.operationStatus(actor, params(request).operation_id)))
  app.get("/:slug/status", (request, reply) => run(request, reply, false, (service, actor) => service.status(actor, params(request).slug)))
  app.post("/:slug/request-review", (request, reply) => run(request, reply, true, (service, actor) => service.requestReview(actor, params(request).slug, key(request), body(request, ["saved_revision"]))))
  app.get("/:slug/preview", (request, reply) => run(request, reply, false, (service, actor) => {
    const query = request.query as { review_id: string; revision_id: string }
    return service.preview(actor, params(request).slug, query.review_id, query.revision_id)
  }))
  app.post("/:slug/approve", { onRequest: approvalGate }, (request, reply) => run(request, reply, true, (service, actor) => service.approve(actor, params(request).slug, key(request), body(request, ["review_id", "revision_id", "saved_revision", "preview_hash"])), true))
  app.get("/:slug/revisions/:revision_id", (request, reply) => run(request, reply, false, (service) => service.approvedRevision(params(request).slug, params(request).revision_id)))
  app.get("/:slug/revisions/:revision_id/assets/:asset_hash", (request, reply) => run(request, reply, false, async (service) => {
    const { slug, revision_id, asset_hash } = params(request)
    const { bytes, format } = await service.asset(slug, revision_id, asset_hash)
    reply.type(format === "jpg" ? "image/jpeg" : `image/${format}`).header("X-Content-Type-Options", "nosniff")
    return bytes
  }))
  done()
}
