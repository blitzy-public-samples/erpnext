import React from 'react'
import rehypeRaw from 'rehype-raw'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeSanitizeServerMarkup from '@/lib/sanitize-html'
// import './markdown.css'

interface MarkdownRendererProps {
    content: string,
    className?: string
}

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
    return <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // `rehypeRaw` turns the HTML embedded in server text into real elements, which
        // `react-markdown` then creates with `document.createElement` - so a `<script>` would run and
        // an `<img src>` would fetch. The sanitiser after it is what makes that safe, and it must stay
        // SECOND: before `rehypeRaw` the hostile markup is still an unparsed `raw` node and the walk
        // would have nothing to remove. See `@/lib/sanitize-html`.
        rehypePlugins={[rehypeRaw, rehypeSanitizeServerMarkup]}
    // components={{
    //     p: (props) => <Text {...props} as='p' />,
    //     ul: (props) => <UnorderedList {...props} />,
    //     ol: (props) => <OrderedList {...props} />,
    //     li: (props) => <ListItem {...props} />,
    //     a: (props) => <Link {...props} />,
    // }}>
    >
        {content}
    </ReactMarkdown>
}

export default MarkdownRenderer
