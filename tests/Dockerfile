FROM mcr.microsoft.com/playwright/mcp:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV NODE_PATH=/app/node_modules
WORKDIR /workspace
ENTRYPOINT ["node"]
