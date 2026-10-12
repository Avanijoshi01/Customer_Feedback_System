const feedbackId = 'your-feedback-id';
const eventSource = new EventSource(`http://localhost:3000/changestream/feedback/${feedbackId}`);

eventSource.onmessage = (event) => {
    const change = JSON.parse(event.data);
    console.log('Feedback change detected:', change);
    
    switch(change.operationType) {
        case 'update':
            console.log('Feedback updated:', change.changes);
            break;
        case 'replace':
            console.log('Feedback replaced:', change.fullDocument);
            break;
        case 'delete':
            console.log('Feedback deleted');
            eventSource.close(); // Close connection if feedback is deleted
            break;
    }
};

eventSource.onerror = (error) => {
    console.error('EventSource failed:', error);
    eventSource.close();
}; 