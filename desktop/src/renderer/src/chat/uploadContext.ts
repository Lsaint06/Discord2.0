import { createContext } from 'react'
import type { UploadManager } from './uploadManager'

/** The workspace's upload manager (uploads outlive the message box of one channel). */
export const UploadContext = createContext<UploadManager | null>(null)
