exports.compareShallowObjects = (obj1, obj2) => {
  return Object.keys(obj1).every(key => (
    obj1[key] === obj2[key]
  ));
}