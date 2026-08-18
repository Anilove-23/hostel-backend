FROM node:24-alpine
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the backend code
COPY . .

EXPOSE 5000
CMD ["node", "index.js"]