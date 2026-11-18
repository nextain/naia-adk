import { handlePersonalScheduleRequest } from "../schedule/personal-schedule"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export async function GET(req: Request) { return handlePersonalScheduleRequest(req) }
export async function POST(req: Request) { return handlePersonalScheduleRequest(req) }
export async function PUT(req: Request) { return handlePersonalScheduleRequest(req) }
export async function PATCH(req: Request) { return handlePersonalScheduleRequest(req) }
export async function DELETE(req: Request) { return handlePersonalScheduleRequest(req) }
