# Use official Node.js 18 LTS image
FROM node:18-slim

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package.json ./
COPY package-lock.json ./
RUN npm install --production

# Bundle app source
COPY . .

# Use a non-root user for security
RUN useradd --user-group --create-home --shell /bin/false appuser
USER appuser

# Expose the port the app runs on
EXPOSE 8080

# Start the server
CMD ["npm", "start"] 
