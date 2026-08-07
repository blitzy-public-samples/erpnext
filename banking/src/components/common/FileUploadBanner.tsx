import { CheckCircle } from 'lucide-react'
import { Progress } from '../ui/progress'
import _ from '@/lib/translate'

const FileUploadBanner = ({
    uploadProgress,
}: { uploadProgress: number }) => {
    return <div className="flex items-center justify-center flex-col gap-4">
        <div className="flex flex-col items-center gap-4">
            <CheckCircle size={48} className="text-ink-green-3" />
            <span className="text-ink-gray-8 text-p-base">{_("The document has been created and reconciled. Uploading attachments...")}</span>
            {/* Named, because a bar announcing a bare number says nothing about what is progressing. */}
            <Progress
                value={Math.round(uploadProgress * 100)}
                max={100}
                size="lg"
                aria-label={_("Attachment upload progress")}
            />
        </div>
    </div>
}

export default FileUploadBanner