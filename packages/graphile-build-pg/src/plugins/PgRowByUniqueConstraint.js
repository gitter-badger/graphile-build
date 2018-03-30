// @flow
import type { Plugin } from "graphile-build";
import queryFromResolveData from "../queryFromResolveData";
import debugFactory from "debug";
import omit from "../omit";
const debugSql = debugFactory("graphile-build-pg:sql");

export default (async function PgRowByUniqueConstraint(builder) {
  builder.hook(
    "GraphQLObjectType:fields",
    (
      fields,
      {
        extend,
        parseResolveInfo,
        pgGetGqlTypeByTypeId,
        pgGetGqlInputTypeByTypeId,
        gql2pg,
        pgIntrospectionResultsByKind: introspectionResultsByKind,
        pgSql: sql,
        graphql: { GraphQLNonNull },
        inflection,
      },
      { scope: { isRootQuery }, fieldWithHooks }
    ) => {
      if (!isRootQuery) {
        return fields;
      }
      return extend(
        fields,
        introspectionResultsByKind.class
          .filter(table => !!table.namespace)
          .reduce((memo, table) => {
            if (omit(table, "read")) {
              return memo;
            }
            const TableType = pgGetGqlTypeByTypeId(table.type.id);
            const sqlFullTableName = sql.identifier(
              table.namespace.name,
              table.name
            );
            if (TableType) {
              const uniqueConstraints = introspectionResultsByKind.constraint
                .filter(con => con.classId === table.id)
                .filter(con => con.type === "u" || con.type === "p");
              const attributes = introspectionResultsByKind.attribute
                .filter(attr => attr.classId === table.id)
                .sort((a, b) => a.num - b.num);
              uniqueConstraints.forEach(constraint => {
                const keys = constraint.keyAttributeNums.map(
                  num => attributes.filter(attr => attr.num === num)[0]
                );
                if (!keys.every(_ => _)) {
                  throw new Error(
                    "Consistency error: could not find an attribute!"
                  );
                }
                const fieldName = inflection.rowByUniqueKeys(
                  keys,
                  table,
                  constraint
                );
                memo[fieldName] = fieldWithHooks(
                  fieldName,
                  ({ getDataFromParsedResolveInfoFragment }) => {
                    return {
                      type: TableType,
                      args: keys.reduce((memo, key) => {
                        const InputType = pgGetGqlInputTypeByTypeId(key.typeId);
                        if (!InputType) {
                          throw new Error(
                            `Could not find input type for key '${
                              key.name
                            }' on type '${TableType.name}'`
                          );
                        }
                        memo[inflection.column(key)] = {
                          type: new GraphQLNonNull(InputType),
                        };
                        return memo;
                      }, {}),
                      async resolve(parent, args, { pgClient }, resolveInfo) {
                        const parsedResolveInfoFragment = parseResolveInfo(
                          resolveInfo
                        );
                        const resolveData = getDataFromParsedResolveInfoFragment(
                          parsedResolveInfoFragment,
                          TableType
                        );
                        const query = queryFromResolveData(
                          sqlFullTableName,
                          undefined,
                          resolveData,
                          {},
                          builder => {
                            keys.forEach(key => {
                              builder.where(
                                sql.fragment`${builder.getTableAlias()}.${sql.identifier(
                                  key.name
                                )} = ${gql2pg(
                                  args[inflection.column(key)],
                                  key.type
                                )}`
                              );
                            });
                          }
                        );
                        const { text, values } = sql.compile(query);
                        if (debugSql.enabled) debugSql(text);
                        const { rows: [row] } = await pgClient.query(
                          text,
                          values
                        );
                        return row;
                      },
                    };
                  },
                  {
                    isPgRowByUniqueConstraintField: true,
                    pgFieldIntrospection: constraint,
                  }
                );
              });
            }
            return memo;
          }, {}),
        `Adding "row by unique constraint" fields to root Query type`
      );
    }
  );
}: Plugin);
