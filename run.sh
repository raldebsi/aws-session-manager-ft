#!/bin/bash
IMAGE_NAME="aws-sessions"

echo "Building image..."
docker build -t "$IMAGE_NAME" .

docker run --rm -it \
    --network host \
    -v "$HOME/.aws:/root/.aws:ro" \
    -v "$HOME/.kube:/root/.kube" \
    -v "$(pwd)/config:/app/config" \
    -e BIND_ALL=1 \
    -p 9400-9800:9400-9800 \
    -p 8000:8000 \
    "$IMAGE_NAME"
