const methods = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace']

module.exports = function (enforcer, upload, options) {
  const map = new WeakMap()

  if (!options) options = {}
  if (!options.hasOwnProperty('directedUploads')) options.directedUploads = false

  const promise = enforcer.promise
    .then(openapi => {
      if (openapi.paths) {
        Object.keys(openapi.paths).forEach(pathKey => {
          const path = openapi.paths[pathKey]
          if (path) {
            methods.forEach(method => {
              const operation = path[method]
              if (operation) {
                // v2
                const v2Body = operation.parameters.find(p => p.in === 'formData')
                if (v2Body) {
                  const {definition, root} = operation.enforcerData
                  const consumes = (definition.consumes || []).concat(root.definition.consumes || [])
                  if (consumes.indexOf('multipart/form-data') !== -1) {
                    const schema = {type: 'object', properties: {}}
                    operation.allParameters
                      .filter(param => param.in === 'formData')
                      .forEach(param => {
                        schema.properties[param.name] = param.schema
                      })
                    buildMulterFields(schema, operation, map, upload, options)
                  }

                  // v3
                } else if (operation.requestBody) {
                  const schema = operation.requestBody.content &&
                    operation.requestBody.content['multipart/form-data'] &&
                    operation.requestBody.content['multipart/form-data'].schema
                  buildMulterFields(schema, operation, map, upload, options)
                }
              }
            })
          }
        })
      }
      return openapi
    })

  return function (req, res, next) {
    promise
      .then(openapi => {

        // get the x-multer property off the operation instance for the request
        const [path] = openapi.path(req.method, req.path)
        if (!path) return next(); // path is not documented in the OpenAPI document, pass to next middleware.
        const operation = path.operation
        const multer = map.get(operation)

        // if there is no multer middleware
        if (!multer) {
          next()

          // there is a multer middleware
        } else {

          // run the multer middleware
          Object.assign(req.params, path.params)
          multer.middleware(req, res, function (err) {
            if (err) return next(err)

            // to correctly apply modification only for form-data type
            if (req.is('multipart')) {
              if (!req.body) req.body = {}
              req.body = prepareBody(req.body)
              Object.keys(req.body).forEach(key => {
                const prop = multer.schema.properties[key]
                if (prop) {
                  const [val, err] = prop.deserialize(req.body[key], { strict: false })
                  if (!err) req.body[key] = val
                }
              })

              // copy multer's "files" to body
              if (req.files) {
                Object.keys(req.files).forEach(key => {
                  const files = req.files[key]
                  const prop = multer.schema.properties[key]
                  if (prop.type === 'array') {
                    req.body[key] = files.map(file => file.buffer || Buffer.allocUnsafe(file.size))
                  } else if (files.length) {
                    const file = files[files.length - 1]
                    req.body[key] = file.buffer || Buffer.allocUnsafe(file.size)
                    req.files[key] = file
                  }
                })
              }
            }
            next()
          })
        }
      })
      .catch(next)
  }
}

// Credits to JacobLey : https://github.com/cdimascio/express-openapi-validator/pull/187
const schemaHasObject = schema =>
    schema && (
        schema.type === 'object' ||
        [].concat(
            schema.allOf,
            schema.oneOf,
            schema.anyOf
        ).some(schemaHasObject)
    )

// for nested levels, we need to deep flat given array
const flatDeep = arr => arr.reduce((acc, val) => acc.concat(Array.isArray(val) ? flatDeep(val) : val), []);

function merge_properties(schema) {
  if (schema.properties) {
    return schema.properties
  } else {
    return [schema.oneOf, schema.allOf, schema.anyOf]
        .filter(s => s !== undefined)
        .map(subschema => subschema.map(s => merge_properties(s)) )
        .reduce( (acc, subproperties) => {
          return Object.assign(acc, ...flatDeep(subproperties))
        }, {})
  }
}

function buildMulterFields(schema, operation, map, uploadMap, {directedUploads}) {
  const isObject = schemaHasObject(schema)
  const properties = (isObject)
      ? (schema.properties)
          ? schema.properties
          : merge_properties(schema)
      : undefined;
  if (schema && isObject && properties) {
    // To deal with all cases, lets be sure schema object has a "properties" field
    const masterSchema = (schema.hasOwnProperty("properties")) ? schema : {"properties": properties};
    const fields = [];
    const multerKey = directedUploads
        ? operation['x-multer-key'] || operation.enforcerData.parent.result['x-multer-key']
        : '';
    const upload = multerKey
        ? uploadMap[multerKey]
        : uploadMap;

    if (!upload && multerKey) throw Error('Unable to find multer definition with the specified key: ' + multerKey)
    if (!upload) throw Error('Invalid multer object provided');

    Object.keys(properties).forEach(key => {
      const item = properties[key];
      if (item.type === 'array' && item.items && schemaIsFileType(item.items)) {
        const config = {name: key};
        if (item.hasOwnProperty('maxItems')) config.maxCount = item.maxItems
        fields.push(config)
      } else if (schemaIsFileType(item)) {
        fields.push({name: key, maxCount: 1})
      }
    });
    if (fields.length) {
      map.set(operation, {
        middleware: upload.fields(fields),
        schema: masterSchema
      })
    }
  }
}

function prepareBody (value) {
  if (Array.isArray(value)) {
    return value.map(v => prepareBody(v))
  } else if (value && typeof value === 'object') {
    const result = {}
    Object.keys(value).forEach(key => {
      result[key] = prepareBody(value[key])
    })
    return result
  } else {
    return value
  }
}

function schemaIsFileType(schema) {
  return schema.type === 'string' && (schema.format === 'byte' || schema.format === 'binary')
}
