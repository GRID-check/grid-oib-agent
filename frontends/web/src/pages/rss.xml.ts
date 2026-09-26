import type { APIRoute } from 'astro'
import { blogFeed } from '../lib/feed'

export const GET: APIRoute = ({ site }) => blogFeed('de', site)
